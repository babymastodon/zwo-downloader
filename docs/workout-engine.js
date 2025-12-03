// workout-engine.js
// Business logic + state for running a workout.
// No direct DOM access; communicates via callbacks.
/** @typedef {import("./zwo.js").CanonicalWorkout} CanonicalWorkout */

import {BleManager} from "./ble-manager.js";
import {Beeper} from "./beeper.js";
import {DEFAULT_FTP} from "./workout-metrics.js";
import {
  loadSelectedWorkout,
  loadActiveState,
  saveActiveState,
  clearActiveState,
  loadWorkoutDirHandle,
} from "./storage.js";

let instance = null;

export function getWorkoutEngine() {
  if (!instance) instance = createWorkoutEngine();
  return instance;
}

function createWorkoutEngine() {
  /** @type {CanonicalWorkout | null} */
  let canonicalWorkout = null;
  let workoutTotalSec = 0;

  let currentFtp = DEFAULT_FTP;
  let mode = "workout"; // "workout" | "erg" | "resistance"
  let manualErgTarget = 200;
  let manualResistance = 30;

  let workoutRunning = false;
  let workoutPaused = false;
  let workoutStarting = false;
  /** @type {Date | null} */
  let workoutStartedAt = null;
  let elapsedSec = 0;
  let currentIntervalIndex = 0;
  let intervalElapsedSec = 0;

  let lastSamplePower = null;
  let lastSampleHr = null;
  let lastSampleCadence = null;

  let zeroPowerSeconds = 0;
  let autoPauseDisabledUntilSec = 0;
  let manualPauseAutoResumeBlockedUntilMs = 0;

  let liveSamples = [];
  let workoutTicker = null;
  let saveStateTimer = null;

  let onStateChanged = () => {};
  let onLog = () => {};
  let onWorkoutEnded = () => {};

  const log = (msg) => onLog(msg);

  // --------- helpers for rawSegments ---------

  function recomputeWorkoutTotalSec() {
    if (!canonicalWorkout) {
      workoutTotalSec = 0;
      return;
    }
    workoutTotalSec = canonicalWorkout.rawSegments.reduce(
      (sum, [minutes]) => sum + Math.max(1, Math.round((minutes || 0) * 60)),
      0
    );
  }

  /**
   * Returns current segment + target power at absolute time tSec.
   * Uses canonicalWorkout.rawSegments directly; no persistent scaled structure.
   */
  function getCurrentSegmentAtTime(tSec) {
    if (!canonicalWorkout || !workoutTotalSec) {
      return {segment: null, target: null, index: -1};
    }

    const ftp = currentFtp || DEFAULT_FTP;
    const t = Math.min(Math.max(0, tSec), workoutTotalSec);
    const raws = canonicalWorkout.rawSegments;

    let acc = 0;
    for (let i = 0; i < raws.length; i++) {
      const [minutes, startPct, endPct] = raws[i];
      const dur = Math.max(1, Math.round((minutes || 0) * 60));
      const start = acc;
      const end = acc + dur;

      if (t < end) {
        const pStartRel = (startPct || 0) / 100;
        const pEndRel = (endPct != null ? endPct : startPct || 0) / 100;
        const rel = (t - start) / dur;
        const startW = pStartRel * ftp;
        const endW = pEndRel * ftp;
        const target = Math.round(
          startW + (endW - startW) * Math.min(1, Math.max(0, rel))
        );

        const segment = {
          durationSec: dur,
          startTimeSec: start,
          endTimeSec: end,
          pStartRel,
          pEndRel,
        };

        currentIntervalIndex = i;
        return {segment, target, index: i};
      }

      acc = end;
    }

    return {segment: null, target: null, index: -1};
  }

  function getCurrentTargetPower() {
    if (mode === "erg") return manualErgTarget;
    if (mode === "resistance") return null;
    if (!canonicalWorkout) return null;
    const t = workoutRunning || elapsedSec > 0 ? elapsedSec : 0;
    const {target} = getCurrentSegmentAtTime(t);
    return target;
  }

  function desiredTrainerState() {
    if (mode === "workout") {
      const value = getCurrentTargetPower();
      return value == null ? null : {kind: "erg", value};
    }
    if (mode === "erg") return {kind: "erg", value: manualErgTarget};
    if (mode === "resistance") return {kind: "resistance", value: manualResistance};
    return null;
  }

  async function sendTrainerState(force = false) {
    const st = desiredTrainerState();
    if (!st) return;
    await BleManager.setTrainerState(st, {force});
  }

  // --------- persistence ---------

  function scheduleSaveActiveState() {
    if (saveStateTimer) return;
    saveStateTimer = setTimeout(() => {
      saveStateTimer = null;
      persistActiveState();
    }, 500);
  }

  function persistActiveState() {
    saveActiveState({
      canonicalWorkout,
      currentFtp,
      mode,
      manualErgTarget,
      manualResistance,
      workoutRunning,
      workoutPaused,
      elapsedSec,
      currentIntervalIndex,
      liveSamples,
      zeroPowerSeconds,
      autoPauseDisabledUntilSec,
      manualPauseAutoResumeBlockedUntilMs,
      workoutStartedAt: workoutStartedAt ? workoutStartedAt.toISOString() : null,
    });
  }

  async function saveWorkoutFile() {
    if (!canonicalWorkout || !liveSamples.length) return;

    const dir = await loadWorkoutDirHandle();
    if (!dir) return;

    const now = new Date();
    const nameSafe =
      canonicalWorkout.workoutTitle
        ?.replace(/[<>:"/\\|?*]+/g, "_")
        .slice(0, 60) || "workout";
    const timestamp = now
      .toISOString()
      .replace(/[:]/g, "-")
      .replace(/\.\d+Z$/, "Z");
    const fileName = `${timestamp} - ${nameSafe}.json`;

    const fileHandle = await dir.getFileHandle(fileName, {create: true});
    const writable = await fileHandle.createWritable();

    const payload = {
      meta: {
        workoutName: canonicalWorkout.workoutTitle,
        fileName: canonicalWorkout.filename,
        ftpUsed: currentFtp,
        startedAt: workoutStartedAt ? workoutStartedAt.toISOString() : null,
        endedAt: now.toISOString(),
        totalElapsedSec: elapsedSec,
        modeHistory: "workout",
      },
      samples: liveSamples,
    };

    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();

    log(`Workout saved to ${fileName}`);
  }

  // --------- auto-start / beeps ---------

  function maybeAutoStartFromPower(power) {
    if (!power || power <= 0) return;
    if (mode !== "workout") return;
    if (workoutRunning || workoutStarting) return;
    if (elapsedSec > 0 || liveSamples.length) return;
    if (!canonicalWorkout) return;

    const [minutes, startPct] = canonicalWorkout.rawSegments[0];
    const ftp = currentFtp || DEFAULT_FTP;
    const pStartRel = (startPct || 50) / 100;
    const startTarget = ftp * pStartRel;
    const threshold = Math.max(75, 0.5 * startTarget);

    if (power >= threshold) {
      log(
        `Auto-start: power ${power.toFixed(
          1
        )}W ≥ threshold ${threshold.toFixed(1)}W`
      );
      startWorkout();
    }
  }

  function handleIntervalBeep(currentT) {
    if (!canonicalWorkout) return;

    const {segment, index} = getCurrentSegmentAtTime(currentT);
    if (!segment || index < 0) return;

    const ftp = currentFtp || DEFAULT_FTP;
    const raws = canonicalWorkout.rawSegments;
    const nextRaw = raws[index + 1];
    if (!nextRaw) return;

    const currEnd = segment.pEndRel * ftp;
    const nextStartPct = nextRaw[1];
    const nextStartRel = (nextStartPct || 0) / 100;
    const nextStart = nextStartRel * ftp;

    const diffFrac = Math.abs(nextStart - currEnd) / currEnd;
    if (diffFrac < 0.1) return;

    const secsToEndInt = Math.round(segment.endTimeSec - currentT);

    if (diffFrac >= 0.3 && nextStartRel >= 1.2 && secsToEndInt === 9) {
      Beeper.playDangerDanger();
    }

    if (secsToEndInt === 3) {
      Beeper.playBeepPattern();
    }
  }

  // --------- ticker ---------

  function startTicker() {
    if (workoutTicker) return;
    workoutTicker = setInterval(async () => {
      const shouldAdvance = workoutRunning && !workoutPaused;

      if (!workoutRunning && !workoutPaused) {
        emitStateChanged();
        return;
      }

      if (shouldAdvance) {
        elapsedSec += 1;
        const {segment, target} = getCurrentSegmentAtTime(elapsedSec);
        intervalElapsedSec = segment ? segment.endTimeSec - elapsedSec : 0;

        const currentTarget = target;

        if (mode === "workout") {
          const inGrace = elapsedSec < autoPauseDisabledUntilSec;

          if (!lastSamplePower || lastSamplePower <= 0) {
            if (!inGrace) zeroPowerSeconds++;
            else zeroPowerSeconds = 0;

            if (!workoutPaused && !inGrace && zeroPowerSeconds >= 1) {
              log("Auto-pause: power at 0 for 1s.");
              setPaused(true, {showOverlay: true});
            }
          } else {
            zeroPowerSeconds = 0;
          }
        }

        await sendTrainerState(false);

        liveSamples.push({
          t: elapsedSec,
          power: lastSamplePower,
          hr: lastSampleHr,
          cadence: lastSampleCadence,
          targetPower: currentTarget || null,
        });

        if (mode === "workout" && workoutRunning && !workoutPaused) {
          handleIntervalBeep(elapsedSec);
        }

        scheduleSaveActiveState();
      }

      if (mode === "workout" && workoutRunning && workoutPaused) {
        const now = Date.now();
        const autoResumeBlocked = now < manualPauseAutoResumeBlockedUntilMs;

        const currentTarget = getCurrentTargetPower();
        if (!autoResumeBlocked && currentTarget && lastSamplePower) {
          if (lastSamplePower >= 0.9 * currentTarget) {
            log("Auto-resume: power high vs target (>=90%).");
            autoPauseDisabledUntilSec = elapsedSec + 15;
            Beeper.showResumedOverlay();
            setPaused(false);
          }
        }
      }

      emitStateChanged();
    }, 1000);
  }

  function stopTicker() {
    if (!workoutTicker) return;
    clearInterval(workoutTicker);
    workoutTicker = null;
  }

  // --------- state transitions ---------

  function emitStateChanged() {
    onStateChanged(getViewModel());
  }

  function setRunning(running) {
    workoutRunning = running;
    workoutPaused = !running;
    if (running && !workoutTicker) startTicker();
    emitStateChanged();
  }

  function setPaused(paused, {showOverlay = false} = {}) {
    workoutPaused = paused;
    if (paused && showOverlay) Beeper.showPausedOverlay();
    emitStateChanged();
  }

  function startWorkout() {
    if (!canonicalWorkout) {
      alert("No workout selected. Choose a workout first.");
      return;
    }
    if (mode !== "workout") {
      alert("Must be in workout mode to begin workout.");
      return;
    }

    if (!workoutRunning && !workoutStarting) {
      workoutStarting = true;
      log("Starting workout (countdown)...");
      Beeper.runStartCountdown(async () => {
        liveSamples = [];
        elapsedSec = 0;

        const [minutes] = canonicalWorkout.rawSegments[0];
        intervalElapsedSec = Math.max(1, Math.round((minutes || 0) * 60));

        currentIntervalIndex = 0;
        workoutStartedAt = new Date();
        zeroPowerSeconds = 0;
        autoPauseDisabledUntilSec = 15;
        manualPauseAutoResumeBlockedUntilMs = 0;

        workoutStarting = false;
        setRunning(true);
        setPaused(false);
        emitStateChanged();
        await sendTrainerState(true);
        scheduleSaveActiveState();
      });
      return;
    }

    if (workoutPaused) {
      log("Manual resume requested.");
      autoPauseDisabledUntilSec = elapsedSec + 15;
      manualPauseAutoResumeBlockedUntilMs = 0;
      Beeper.showResumedOverlay();
      setPaused(false);
    } else {
      log("Manual pause requested.");
      manualPauseAutoResumeBlockedUntilMs = Date.now() + 10_000;
      Beeper.showPausedOverlay();
      setPaused(true);
    }
  }

  async function endWorkout() {
    log("Ending workout, saving file if samples exist.");
    stopTicker();
    if (liveSamples.length) {
      try {
        await saveWorkoutFile();
      } catch (err) {
        log("Failed to save workout file: " + err);
      }
    }
    workoutRunning = false;
    workoutPaused = false;
    workoutStarting = false;
    elapsedSec = 0;
    intervalElapsedSec = 0;
    liveSamples = [];
    zeroPowerSeconds = 0;
    autoPauseDisabledUntilSec = 0;
    manualPauseAutoResumeBlockedUntilMs = 0;
    stopTicker();
    clearActiveState();
    emitStateChanged();
    onWorkoutEnded();
  }

  // --------- BLE sample handlers ---------

  function handleBikeSample(sample) {
    lastSamplePower = sample.power;
    lastSampleCadence = sample.cadence;
    if (sample.hrFromBike != null && lastSampleHr == null) {
      lastSampleHr = sample.hrFromBike;
    }
    maybeAutoStartFromPower(lastSamplePower || 0);
    emitStateChanged();
  }

  function handleHrSample(bpm) {
    lastSampleHr = bpm;
    emitStateChanged();
  }

  // --------- view model ---------

  function getViewModel() {
    return {
      canonicalWorkout,
      workoutTotalSec,
      currentFtp,
      mode,
      manualErgTarget,
      manualResistance,
      workoutRunning,
      workoutPaused,
      workoutStarting,
      workoutStartedAt,
      elapsedSec,
      intervalElapsedSec,
      currentIntervalIndex,
      lastSamplePower,
      lastSampleHr,
      lastSampleCadence,
      liveSamples,
    };
  }

  // --------- public API ---------

  async function init({onStateChanged: onChange, onLog: onLogCb, onWorkoutEnded: onEnd} = {}) {
    if (onChange) onStateChanged = onChange;
    if (onLogCb) onLog = onLogCb;
    if (onEnd) onWorkoutEnded = onEnd;

    log("Workout engine init…");

    BleManager.on("bikeSample", handleBikeSample);
    BleManager.on("hrSample", handleHrSample);
    BleManager.init({autoReconnect: true});

    const selected = await loadSelectedWorkout();
    if (selected) {
      canonicalWorkout = selected;
      recomputeWorkoutTotalSec();
    }

    const active = await loadActiveState();
    if (active) {
      log("Restoring previous active workout state.");

      canonicalWorkout = active.canonicalWorkout || canonicalWorkout;
      currentFtp = active.currentFtp || currentFtp;
      mode = active.mode || mode;
      manualErgTarget = active.manualErgTarget || manualErgTarget;
      manualResistance = active.manualResistance || manualResistance;
      workoutRunning = !!active.workoutRunning;
      workoutPaused = true;
      elapsedSec = active.elapsedSec || 0;
      currentIntervalIndex = active.currentIntervalIndex || 0;
      liveSamples = active.liveSamples || [];
      zeroPowerSeconds = active.zeroPowerSeconds || 0;
      autoPauseDisabledUntilSec = active.autoPauseDisabledUntilSec || 0;
      manualPauseAutoResumeBlockedUntilMs =
        active.manualPauseAutoResumeBlockedUntilMs || 0;
      workoutStartedAt = active.workoutStartedAt
        ? new Date(active.workoutStartedAt)
        : null;

      recomputeWorkoutTotalSec();
    }

    if (workoutRunning) {
      startTicker();
      setPaused(true);
    }

    emitStateChanged();
  }

  return {
    init,
    getViewModel,

    setMode(newMode) {
      if (newMode === mode || workoutStarting) return;
      mode = newMode;
      scheduleSaveActiveState();
      sendTrainerState(true).catch((err) =>
        log("Trainer state send on mode change failed: " + err)
      );
      emitStateChanged();
    },

    setFtp(newFtp) {
      currentFtp = newFtp || DEFAULT_FTP;
      scheduleSaveActiveState();
      sendTrainerState(true).catch((err) =>
        log("Trainer state send after FTP change failed: " + err)
      );
      emitStateChanged();
    },

    adjustManualErg(delta) {
      manualErgTarget = Math.max(50, Math.min(1500, manualErgTarget + delta));
      scheduleSaveActiveState();
      sendTrainerState(true).catch(() => {});
      emitStateChanged();
    },

    adjustManualResistance(delta) {
      manualResistance = Math.max(0, Math.min(100, manualResistance + delta));
      scheduleSaveActiveState();
      sendTrainerState(true).catch(() => {});
      emitStateChanged();
    },

    /**
     * Accept a CanonicalWorkout from the picker / builder.
     */
    setWorkoutFromPicker(canonical) {
      if (workoutRunning || workoutPaused || workoutStarting) {
        alert("Please end your current workout first.");
        return;
      }

      if (!canonical || !Array.isArray(canonical.rawSegments)) {
        console.warn("[WorkoutEngine] Invalid CanonicalWorkout payload:", canonical);
        return;
      }

      canonicalWorkout = canonical;

      if (!currentFtp || !Number.isFinite(currentFtp)) {
        currentFtp = DEFAULT_FTP;
      }

      elapsedSec = 0;
      currentIntervalIndex = 0;
      liveSamples = [];
      zeroPowerSeconds = 0;
      autoPauseDisabledUntilSec = 0;
      manualPauseAutoResumeBlockedUntilMs = 0;

      recomputeWorkoutTotalSec();

      clearActiveState();
      emitStateChanged();
    },

    handleBikeSample,
    handleHrSample,

    startWorkout,
    endWorkout,
  };
}
