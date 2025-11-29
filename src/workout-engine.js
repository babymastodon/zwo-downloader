// workout-engine.js
// Business logic + state for running a workout.
// No direct DOM access; communicates via callbacks.

import {BleManager} from "./ble-manager.js";
import {Beeper} from "./beeper.js";
import {
  DEFAULT_FTP,
  computeScaledSegments,
} from "./workout-metrics.js";
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
  // --------- internal state (no DOM here) ---------
  let workoutMeta = null;
  let scaledSegments = [];
  let workoutTotalSec = 0;

  let currentFtp = DEFAULT_FTP;
  let mode = "workout"; // "workout" | "erg" | "resistance"
  let manualErgTarget = 200;
  let manualResistance = 30;

  let workoutRunning = false;
  let workoutPaused = false;
  let workoutStarting = false;
  let workoutStartedAt = null;
  let elapsedSec = 0;
  let currentIntervalIndex = 0;
  let intervalElapsedSec = 0;

  let lastSamplePower = null;
  let lastSampleHr = null;
  let lastSampleCadence = null;

  let zeroPowerSeconds = 0;
  let autoPauseDisabledUntilSec = 0;

  let liveSamples = [];
  let workoutTicker = null;

  let saveStateTimer = null;

  // --------- callbacks into UI ---------
  let onStateChanged = () => {};
  let onLog = () => {};
  let onWorkoutEnded = () => {};

  function log(msg) {
    onLog(msg);
  }

  // --------- helper: recompute segments ---------
  function rebuildScaledSegments() {
    if (!workoutMeta || !Array.isArray(workoutMeta.segmentsForMetrics)) {
      scaledSegments = [];
      workoutTotalSec = 0;
      return;
    }
    const {scaledSegments: scaled, totalSec} = computeScaledSegments(
      workoutMeta.segmentsForMetrics,
      currentFtp || workoutMeta.ftpAtSelection || DEFAULT_FTP
    );
    scaledSegments = scaled;
    workoutTotalSec = totalSec;
  }

  function getCurrentSegmentAtTime(tSec) {
    if (!scaledSegments.length) return {segment: null, target: null};
    const clampedT = Math.min(Math.max(0, tSec), workoutTotalSec);
    let seg = scaledSegments[currentIntervalIndex];

    if (!seg || clampedT < seg.startTimeSec || clampedT >= seg.endTimeSec) {
      seg = scaledSegments.find(
        (s) => clampedT >= s.startTimeSec && clampedT < s.endTimeSec
      );
      if (seg) currentIntervalIndex = scaledSegments.indexOf(seg);
    }

    if (!seg) return {segment: null, target: null};

    const rel = (clampedT - seg.startTimeSec) / seg.durationSec;
    const target =
      seg.targetWattsStart +
      (seg.targetWattsEnd - seg.targetWattsStart) *
      Math.min(1, Math.max(0, rel));

    return {segment: seg, target: Math.round(target)};
  }

  function getCurrentTargetPower() {
    if (mode === "erg") return manualErgTarget;
    if (mode === "resistance") return null;
    if (!scaledSegments.length) return null;
    const t = workoutRunning || elapsedSec > 0 ? elapsedSec : 0;
    const {target} = getCurrentSegmentAtTime(t);
    return target;
  }

  function desiredTrainerState() {
    if (mode === "workout") {
      const target = getCurrentTargetPower();
      if (target == null) return null;
      return {kind: "erg", value: target};
    }
    if (mode === "erg") {
      return {kind: "erg", value: manualErgTarget};
    }
    if (mode === "resistance") {
      return {kind: "resistance", value: manualResistance};
    }
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
    const state = {
      workoutMeta,
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
      workoutStartedAt: workoutStartedAt
        ? workoutStartedAt.toISOString()
        : null,
    };
    saveActiveState(state);
  }

  async function saveWorkoutFile() {
    if (!workoutMeta || !liveSamples.length) return;

    const dir = await loadWorkoutDirHandle();
    if (!dir) return;

    const now = new Date();
    const nameSafe =
      workoutMeta.name?.replace(/[<>:"/\\|?*]+/g, "_").slice(0, 60) ||
      "workout";
    const timestamp = now
      .toISOString()
      .replace(/[:]/g, "-")
      .replace(/\.\d+Z$/, "Z");
    const fileName = `${timestamp} - ${nameSafe}.json`;

    const fileHandle = await dir.getFileHandle(fileName, {create: true});
    const writable = await fileHandle.createWritable();

    const payload = {
      meta: {
        workoutName: workoutMeta.name,
        fileName: workoutMeta.fileName,
        ftpUsed: currentFtp,
        startedAt: workoutStartedAt
          ? workoutStartedAt.toISOString()
          : null,
        endedAt: now.toISOString(),
        totalElapsedSec: elapsedSec,
        modeHistory: "workout",
      },
      samples: liveSamples,
    };

    const text = JSON.stringify(payload, null, 2);
    await writable.write(text);
    await writable.close();

    log(`Workout saved to ${fileName}`);
  }

  // --------- auto-start / beeps ---------

  function maybeAutoStartFromPower(power) {
    if (!power || power <= 0) return;
    if (mode !== "workout") return;
    if (workoutRunning || workoutStarting) return;
    if (elapsedSec > 0 || liveSamples.length) return;
    if (!scaledSegments.length) {
      if (power >= 75) {
        log("Auto-start (no segments, power >= 75W).");
        startWorkout();
      }
      return;
    }

    const first = scaledSegments[0];
    const startTarget =
      (first && first.targetWattsStart) ||
      (currentFtp || DEFAULT_FTP) * (first?.pStartRel || 0.5);
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
    if (!scaledSegments.length) return;

    const {segment} = getCurrentSegmentAtTime(currentT);
    if (!segment) return;

    const ftp = currentFtp || DEFAULT_FTP;
    const idx = scaledSegments.indexOf(segment);
    const next =
      idx >= 0 && idx < scaledSegments.length - 1
        ? scaledSegments[idx + 1]
        : null;

    if (!next || !ftp) return;

    const currEnd =
      segment.targetWattsEnd != null
        ? segment.targetWattsEnd
        : segment.pEndRel * ftp;

    const nextStart =
      next.targetWattsStart != null
        ? next.targetWattsStart
        : next.pStartRel * ftp;

    if (!currEnd || currEnd <= 0) return;

    const diffFrac = Math.abs(nextStart - currEnd) / currEnd;
    if (diffFrac < 0.1) return;

    const secsToEnd = segment.endTimeSec - currentT;
    const secsToEndInt = Math.round(secsToEnd);

    const nextTargetPct =
      next.targetWattsStart != null
        ? next.targetWattsStart / ftp
        : next.pStartRel;

    if (diffFrac >= 0.3 && nextTargetPct >= 1.2 && secsToEndInt === 9) {
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
            if (!inGrace) {
              zeroPowerSeconds++;
            } else {
              zeroPowerSeconds = 0;
            }
            if (
              !workoutPaused &&
              !inGrace &&
              zeroPowerSeconds >= 1
            ) {
              log("Auto-pause: power at 0 for 1s.");
              setPaused(true, {showOverlay: true});
            }
          } else {
            zeroPowerSeconds = 0;
          }
        }

        await sendTrainerState(false);

        const t = elapsedSec;
        liveSamples.push({
          t,
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
        const currentTarget = getCurrentTargetPower();
        if (currentTarget && lastSamplePower) {
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
    if (workoutTicker) {
      clearInterval(workoutTicker);
      workoutTicker = null;
    }
  }

  // --------- state transitions ---------

  function emitStateChanged() {
    onStateChanged(getViewModel());
  }

  function setRunning(running) {
    workoutRunning = running;
    workoutPaused = !running;
    if (running && !workoutTicker) {
      startTicker();
    }
    emitStateChanged();
  }

  function setPaused(paused, {showOverlay = false} = {}) {
    workoutPaused = paused;
    if (paused && showOverlay) {
      Beeper.showPausedOverlay();
    }
    emitStateChanged();
  }

  function startWorkout() {
    if (!workoutMeta || !scaledSegments.length) {
      alert("No workout selected. Choose a workout first.");
      return;
    }

    if (!workoutRunning && !workoutStarting) {
      workoutStarting = true;
      log("Starting workout (countdown)...");
      Beeper.runStartCountdown(async () => {
        liveSamples = [];
        elapsedSec = 0;
        intervalElapsedSec = scaledSegments[0]?.durationSec || 0;
        currentIntervalIndex = 0;
        workoutStartedAt = new Date();
        zeroPowerSeconds = 0;
        autoPauseDisabledUntilSec = elapsedSec + 15;

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
      Beeper.showResumedOverlay();
      setPaused(false);
    } else {
      log("Manual pause requested.");
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
    stopTicker();
    clearActiveState();
    emitStateChanged();
    onWorkoutEnded();
  }

  // --------- BLE sample handlers ---------

  function handleBikeSample(sample) {
    lastSamplePower = sample.power;
    lastSampleCadence = sample.cadence;
    // HR from bike if no dedicated HRM: handled by UI or engine; here keep simple:
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
      // core state
      workoutMeta,
      scaledSegments,
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
      // samples
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
      workoutMeta = selected;
      currentFtp = selected.ftpAtSelection || DEFAULT_FTP;
      rebuildScaledSegments();
    }

    const active = await loadActiveState();
    if (active && active.workoutMeta && active.liveSamples) {
      log("Restoring previous active workout state.");
      workoutMeta = active.workoutMeta;
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
      autoPauseDisabledUntilSec =
        active.autoPauseDisabledUntilSec || 0;
      workoutStartedAt = active.workoutStartedAt
        ? new Date(active.workoutStartedAt)
        : null;

      rebuildScaledSegments();
    }

    if (workoutRunning) {
      startTicker();
      setPaused(true);
    }

    emitStateChanged();
  }

  return {
    // lifecycle
    init,
    getViewModel,

    // state change
    setMode(newMode) {
      if (newMode === mode) return;
      mode = newMode;
      scheduleSaveActiveState();
      sendTrainerState(true).catch((err) =>
        log("Trainer state send on mode change failed: " + err)
      );
      emitStateChanged();
    },
    setFtp(newFtp) {
      currentFtp = newFtp;
      rebuildScaledSegments();
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
    setWorkoutFromPicker(payload) {
      workoutMeta = payload;
      currentFtp = payload.ftpAtSelection || currentFtp || DEFAULT_FTP;
      elapsedSec = 0;
      currentIntervalIndex = 0;
      liveSamples = [];
      zeroPowerSeconds = 0;
      autoPauseDisabledUntilSec = 0;
      rebuildScaledSegments();
      clearActiveState();
      emitStateChanged();
    },

    // BLE updates
    handleBikeSample,
    handleHrSample,

    // control
    startWorkout,
    endWorkout,
  };
}

