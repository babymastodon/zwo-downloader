// workout.js
// UI layer for running a workout against a Wahoo KICKR over BLE.
// All business logic & state is owned by workout-engine.js.
// This file:
//   - wires DOM events to the engine
//   - renders HUD stats, chart
//   - manages picker UI
//   - forwards logs to settings.js for display

import {Beeper} from "./beeper.js";
import {BleManager} from "./ble-manager.js";
import {getWorkoutEngine} from "./workout-engine.js";
import {getWorkoutPicker} from "./workout-picker.js";
import {initWelcomeTour} from "./welcome.js";


import {
  getCssVar,
  mixColors,
  zoneInfoFromRel,
  drawWorkoutChart,
} from "./workout-chart.js";

import {DEFAULT_FTP, getAdjustedKjForPicker} from "./workout-metrics.js";
import {initSettings, addLogLineToSettings, openSettingsModal} from "./settings.js";
import {
  loadLastScrapedWorkout,
  wasWorkoutJustScraped,
  clearJustScrapedFlag,
  hasSeenWelcome,
  setWelcomeSeen,
  loadRootDirHandle,
} from "./storage.js";
import {isSettingsModalOpen} from "./settings.js";

// --------------------------- DOM refs ---------------------------

const statPowerEl = document.getElementById("stat-power");
const statIntervalTimeEl = document.getElementById("stat-interval-time");
const statHrEl = document.getElementById("stat-hr");
const statTargetPowerEl = document.getElementById("stat-target-power");
const statElapsedTimeEl = document.getElementById("stat-elapsed-time");
const statCadenceEl = document.getElementById("stat-cadence");

const chartSvg = document.getElementById("chartSvg");
const chartPanel = document.getElementById("chartPanel");
const chartTooltip = document.getElementById("chartTooltip");

// Shared empty-state template refs
const chartEmptyOverlay = document.getElementById("chartEmptyOverlay");
const chartEmptyMessage = document.getElementById("chartEmptyMessage");
const chartEmptyArrow = document.getElementById("chartEmptyArrow");

const bikeConnectBtn = document.getElementById("bikeConnectBtn");
const bikeStatusDot = document.getElementById("bikeStatusDot");
const hrConnectBtn = document.getElementById("hrConnectBtn");
const hrStatusDot = document.getElementById("hrStatusDot");
const hrBatteryLabel = document.getElementById("hrBatteryLabel");

const modeToggle = document.getElementById("modeToggle");
const modeButtons = modeToggle
  ? Array.from(modeToggle.querySelectorAll(".mode-toggle-button"))
  : [];

const manualControls = document.getElementById("manualControls");
const manualInputEl = document.getElementById("manualInput");
const manualUnitEl = document.getElementById("manualUnit");

const startBtn = document.getElementById("startBtn");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const stopBtn = document.getElementById("stopBtn");
const workoutNameLabel = document.getElementById("workoutNameLabel");
const workoutTitleCenter = document.getElementById("workoutTitleCenter");

// --------------------------- UI-local state ---------------------------

let hrBatteryPercent = null;
let bikeConnected = false;

const logLines = [];
let chartWidth = 1000;
let chartHeight = 400;

// Ensure we only ever run handleLastScrapedWorkout once at a time
let isHandlingLastScrapedWorkout = false;

// engine & picker are created in initPage
let engine = null;
let picker = null;
let welcomeTour = null;
let welcomeSeenAlready = false;
const hasWelcomeOverlay = !!document.getElementById("welcomeOverlay");
let isWelcomeActive = hasWelcomeOverlay;

// --------------------------- Helpers ---------------------------

function logDebug(msg) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}`;
  logLines.push(line);
  if (logLines.length > 5000) {
    logLines.splice(0, logLines.length - 5000);
  }

  try {
    addLogLineToSettings(line);
  } catch (err) {
    console.error("[Workout] Failed to forward log to settings:", err);
  }
}

function setWelcomeActive(active) {
  isWelcomeActive = !!active;
  if (document && document.body) {
    document.body.classList.toggle("welcome-active", isWelcomeActive);
  }
}

function hideWelcomeOverlayFallback() {
  const overlayEl = document.getElementById("welcomeOverlay");
  if (!overlayEl) return;
  overlayEl.style.display = "none";
  overlayEl.classList.remove(
    "welcome-overlay--visible",
    "welcome-overlay--splash-only"
  );
}

async function ensureRootDirConfiguredForWorkouts() {
  try {
    const handle =
      typeof loadRootDirHandle === "function" ? await loadRootDirHandle() : null;
    if (handle) return true;
  } catch (err) {
    logDebug("Error checking root dir: " + err);
  }
  alert("Choose a VeloDrive folder first, then pick a workout.");
  openSettingsModal();
  return false;
}

async function openPickerWithGuard(focusName) {
  if (!picker || typeof picker.open !== "function") return;
  const ok = await ensureRootDirConfiguredForWorkouts();
  if (!ok) return;
  picker
    .open(focusName)
    .catch((err) => logDebug("Workout picker open error: " + err));
}

function primeAudioContext() {
  const warm = () => {
    try {
      const maybe = Beeper && typeof Beeper.warmUp === "function" ? Beeper.warmUp() : null;
      if (maybe && typeof maybe.catch === "function") {
        maybe.catch((err) => logDebug("Audio warm-up failed: " + err));
      }
    } catch (err) {
      logDebug("Audio warm-up failed: " + err);
    }
  };

  warm();

  const once = () => warm();
  window.addEventListener("pointerdown", once, {once: true});
  window.addEventListener("keydown", once, {once: true});
}

function isAnyModalOpen() {
  const pickerOpen =
    picker && typeof picker.isOpen === "function" ? picker.isOpen() : false;
  const settingsOpen = typeof isSettingsModalOpen === "function"
    ? isSettingsModalOpen()
    : false;
  return pickerOpen || settingsOpen;
}

function formatTimeMMSS(sec) {
  const s = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function formatTimeHHMMSS(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (
    String(h).padStart(2, "0") +
    ":" +
    String(m).padStart(2, "0") +
    ":" +
    String(ss).padStart(2, "0")
  );
}

function buildWorkoutTooltip(vm) {
  const cw = vm && vm.canonicalWorkout;
  if (!cw) return "";

  const currentFtp = vm.currentFtp || cw.baseFtp || DEFAULT_FTP;
  const parts = [];

  if (cw.workoutTitle) parts.push(cw.workoutTitle);

  if (vm.workoutTotalSec) {
    const mins = Math.round(vm.workoutTotalSec / 60);
    parts.push(`Duration: ${mins} min`);
  }

  if (cw.zone) parts.push(`Zone: ${cw.zone}`);
  if (typeof cw.ifValue === "number") parts.push(`IF: ${cw.ifValue.toFixed(2)}`);
  if (typeof cw.tss === "number") parts.push(`TSS: ${Math.round(cw.tss)}`);
  parts.push(`FTP: ${Math.round(currentFtp)}`);

  if (typeof cw.baseKj === "number" && typeof cw.ftpFromFile === "number") {
    const kJ = getAdjustedKjForPicker(cw.baseKj, cw.ftpFromFile, currentFtp);
    parts.push(`kJ: ${Math.round(kJ)}`);
  }

  if (cw.description) {
    parts.push("");
    parts.push(cw.description);
  }

  return parts.join("\n");
}

function updateWorkoutTitleUI(vm) {
  const cw = vm.canonicalWorkout;

  if (workoutNameLabel) {
    if (cw) {
      const name =
        cw.workoutTitle ||
        cw.name ||
        "Selected workout";
      workoutNameLabel.textContent = name;
      workoutNameLabel.title = name;
    } else {
      workoutNameLabel.textContent = "Click here to select a workout";
      workoutNameLabel.title = "";
    }
  }

  if (workoutTitleCenter && modeToggle) {
    if (vm.workoutRunning || vm.workoutStarting) {
      modeToggle.style.display = "none";
      workoutTitleCenter.style.display = "block";

      const name =
        cw?.workoutTitle ||
        cw?.name ||
        "Workout running";
      workoutTitleCenter.textContent = name;
      workoutTitleCenter.title = buildWorkoutTooltip(vm);

      if (workoutNameLabel) {
        workoutNameLabel.style.display = "none";
      }
    } else {
      modeToggle.style.display = "inline-flex";
      workoutTitleCenter.style.display = "none";
      workoutTitleCenter.title = "";
    }
  }
}

// --------------------------- Dynamic stat font sizing ---------------------------

function adjustStatFontSizes() {
  const cards = document.querySelectorAll(".stat-card");
  cards.forEach((card) => {
    const valueEl = card.querySelector(".stat-value");
    if (!valueEl) return;
    const labelEl = card.querySelector(".stat-label");
    const cardRect = card.getBoundingClientRect();
    if (!cardRect.width || !cardRect.height) return;

    const labelRect = labelEl ? labelEl.getBoundingClientRect() : {height: 0};
    const availableHeight = cardRect.height - labelRect.height - 6;
    const availableWidth = cardRect.width;
    const isDouble = valueEl.classList.contains("stat-lg");
    const fs = Math.max(
      18,
      Math.min(availableHeight, availableWidth / (isDouble ? 6 : 3)) * 0.9
    );
    valueEl.style.fontSize = `${fs}px`;
  });
}

// --------------------------- Chart dimension helpers ---------------------------

function updateChartDimensions() {
  if (!chartPanel) return;
  const rect = chartPanel.getBoundingClientRect();
  const w = rect.width || window.innerWidth || 1200;
  const h = rect.height || Math.floor((window.innerHeight || 800) / 2);
  chartWidth = Math.max(200, Math.floor(w));
  chartHeight = Math.max(200, Math.floor(h));
}

// --------------------------- BLE integration (UI side) ---------------------------

function setBikeStatus({state, message}) {
  if (!bikeStatusDot) return;

  if (bikeConnectBtn) {
    if (message) bikeConnectBtn.title = message;
    else bikeConnectBtn.removeAttribute("title");
  }

  bikeStatusDot.classList.remove("connected", "connecting", "error");

  const prevConnected = bikeConnected;

  if (state === "connected") {
    bikeStatusDot.classList.add("connected");
    bikeConnected = true;
  } else if (state === "connecting") {
    bikeStatusDot.classList.add("connecting");
    bikeConnected = false;
  } else if (state === "error") {
    bikeStatusDot.classList.add("error");
    bikeConnected = false;
  } else {
    bikeConnected = false;
  }

  if (engine && bikeConnected !== prevConnected) {
    const vm = engine.getViewModel();
    drawChart(vm);
  }
}

function setHrStatus({state, message}) {
  if (!hrStatusDot) return;

  if (hrConnectBtn) {
    if (message) hrConnectBtn.title = message;
    else hrConnectBtn.removeAttribute("title");
  }

  hrStatusDot.classList.remove("connected", "connecting", "error");

  if (state === "connected") {
    hrStatusDot.classList.add("connected");
  } else if (state === "connecting") {
    hrStatusDot.classList.add("connecting");
  } else if (state === "error") {
    hrStatusDot.classList.add("error");
  }
}

function updateHrBatteryLabel() {
  if (!hrBatteryLabel) return;
  if (hrBatteryPercent == null) {
    hrBatteryLabel.textContent = "";
    hrBatteryLabel.classList.remove("battery-low");
    return;
  }
  hrBatteryLabel.textContent = `${hrBatteryPercent}%`;
  hrBatteryLabel.classList.toggle("battery-low", hrBatteryPercent <= 20);
}

function initBleIntegration() {
  BleManager.on("bikeStatus", setBikeStatus);
  BleManager.on("hrStatus", setHrStatus);

  BleManager.on("hrBattery", (pct) => {
    hrBatteryPercent = pct;
    updateHrBatteryLabel();
  });

  BleManager.on("log", logDebug);
}

// --------------------------- Workout structure helpers ---------------------------

// Total duration from CanonicalWorkout.rawSegments
function totalDurationSec(rawSegments) {
  return rawSegments.reduce(
    (sum, [minutes]) => sum + Math.max(1, Math.round((minutes || 0) * 60)),
    0
  );
}

/**
 * Compute target workout power at a given time (seconds),
 * based on canonicalWorkout.rawSegments. Used for zone color + stats.
 */
function getWorkoutTargetAtTime(vm, tSec) {
  const cw = vm.canonicalWorkout;
  const raws = cw && cw.rawSegments;
  if (!raws || !raws.length) return null;

  const ftp = vm.currentFtp || cw.baseFtp || DEFAULT_FTP;
  const totalSec = vm.workoutTotalSec || totalDurationSec(raws);
  const t = Math.min(Math.max(0, tSec), totalSec || 1);

  let acc = 0;
  for (const [minutes, startPct, endPct] of raws) {
    const dur = Math.max(1, Math.round((minutes || 0) * 60));
    const start = acc;
    const end = acc + dur;
    if (t < end) {
      const pStartRel = (startPct || 0) / 100;
      const pEndRel = (endPct != null ? endPct : startPct || 0) / 100;
      const rel = (t - start) / dur;
      const startW = pStartRel * ftp;
      const endW = pEndRel * ftp;
      const target = startW + (endW - startW) * Math.min(1, Math.max(0, rel));
      return Math.round(target);
    }
    acc = end;
  }

  return null;
}

// --------------------------- Zone color & stats rendering ---------------------------

function getCurrentZoneColor(vm) {
  const ftp = vm.currentFtp || DEFAULT_FTP;
  let refPower;

  if (vm.mode === "workout") {
    const t = vm.elapsedSec > 0 ? vm.elapsedSec : 0;
    const target = getWorkoutTargetAtTime(vm, t);
    refPower = target || vm.lastSamplePower || ftp * 0.6;
  } else if (vm.mode === "erg") {
    refPower = vm.manualErgTarget || ftp * 0.6;
  } else {
    refPower = (vm.manualResistance / 100) * ftp || ftp * 0.5;
  }

  const rel = refPower / ftp;
  const zone = zoneInfoFromRel(rel);
  return zone.color || getCssVar("--text-main");
}

function updateStatsDisplay(vm) {
  if (!statPowerEl || !statHrEl || !statCadenceEl) return;

  if (vm.lastSamplePower == null) {
    statPowerEl.textContent = "--";
  } else {
    const p = Math.round(vm.lastSamplePower);
    statPowerEl.textContent = String(p < 0 ? 0 : p);
  }

  let target = null;
  if (vm.mode === "erg") {
    target = vm.manualErgTarget;
  } else if (vm.mode === "workout" && vm.canonicalWorkout?.rawSegments?.length) {
    const t = vm.workoutRunning || vm.elapsedSec > 0 ? vm.elapsedSec : 0;
    target = getWorkoutTargetAtTime(vm, t);
  }

  if (statTargetPowerEl) {
    statTargetPowerEl.textContent =
      target != null ? String(Math.round(target)) : "--";
  }

  statHrEl.textContent =
    vm.lastSampleHr != null ? String(Math.round(vm.lastSampleHr)) : "--";

  statCadenceEl.textContent =
    vm.lastSampleCadence != null
      ? String(Math.round(vm.lastSampleCadence))
      : "--";

  if (statElapsedTimeEl) {
    statElapsedTimeEl.textContent = formatTimeHHMMSS(vm.elapsedSec || 0);
  }
  if (statIntervalTimeEl) {
    statIntervalTimeEl.textContent = formatTimeMMSS(vm.intervalElapsedSec || 0);
  }

  let color = getCurrentZoneColor(vm);
  color = mixColors(color, "#000000", 0.3);

  document
    .querySelectorAll(".stat-value span")
    .forEach((el) => (el.style.color = color));
}

// --------------------------- Chart empty-state helper ---------------------------

/**
 * kind: "none" | "noBike" | "noWorkout" | "readyToStart" | "resume"
 */
function setChartEmptyState(kind) {
  if (!chartEmptyOverlay || !chartEmptyMessage || !chartEmptyArrow) return;

  if (kind === "none") {
    chartEmptyOverlay.style.display = "none";
    return;
  }

  chartEmptyOverlay.style.display = "flex";
  chartEmptyArrow.style.display = "";
  chartEmptyArrow.classList.remove(
    "chart-empty-arrow--left",
    "chart-empty-arrow--right"
  );

  if (kind === "noBike") {
    chartEmptyMessage.textContent = "Connect your bike";
    chartEmptyArrow.classList.add("chart-empty-arrow--left");
  } else if (kind === "noWorkout") {
    chartEmptyMessage.textContent = "Select a workout";
    chartEmptyArrow.classList.add("chart-empty-arrow--right");
  } else if (kind === "readyToStart") {
    chartEmptyMessage.textContent = "Pedal to start workout";
    chartEmptyArrow.classList.add("chart-empty-arrow--right");
  } else if (kind === "resume") {
    chartEmptyMessage.textContent = "Pedal to resume";
    chartEmptyArrow.style.display = "none";
  }
}

// --------------------------- Chart rendering ---------------------------

function drawChart(vm) {
  if (!chartSvg || !chartPanel) return;

  const showReadyToStart =
    bikeConnected &&
    vm &&
    vm.mode === "workout" &&
    vm.canonicalWorkout &&
    !vm.workoutRunning &&
    (vm.elapsedSec || 0) === 0;

  const showResume =
    bikeConnected &&
    vm &&
    vm.mode === "workout" &&
    vm.workoutPaused === true &&
    vm.workoutRunning;

  const showNoWorkout =
    vm &&
    vm.mode === "workout" &&
    !vm.canonicalWorkout &&
    !vm.workoutRunning;

  const showNoBike = !bikeConnected;

  if (showResume) {
    setChartEmptyState("resume");
  } else if (showReadyToStart) {
    setChartEmptyState("readyToStart");
  } else if (showNoWorkout) {
    setChartEmptyState("noWorkout");
  } else if (showNoBike) {
    setChartEmptyState("noBike");
  } else {
    setChartEmptyState("none");
  }

  updateChartDimensions();

  drawWorkoutChart({
    svg: chartSvg,
    panel: chartPanel,
    tooltipEl: chartTooltip,
    width: chartWidth,
    height: chartHeight,
    mode: vm.mode,
    ftp: vm.currentFtp || DEFAULT_FTP,
    rawSegments: vm.canonicalWorkout?.rawSegments || [],
    elapsedSec: vm.elapsedSec,
    liveSamples: vm.liveSamples,
    manualErgTarget: vm.manualErgTarget,
  });
}

// --------------------------- Playback buttons ---------------------------

function updatePlaybackButtons(vm) {
  [startBtn, playBtn, pauseBtn, stopBtn].forEach((btn) => {
    if (btn) btn.classList.remove("visible");
  });

  if (vm.mode === "workout" && !vm.canonicalWorkout) {
    return;
  }

  if (!vm.workoutRunning) {
    if (vm.mode === "workout" && vm.canonicalWorkout && startBtn) {
      startBtn.classList.add("visible");
    }
    return;
  }

  if (stopBtn) stopBtn.classList.add("visible");

  if (vm.workoutPaused) {
    if (playBtn) playBtn.classList.add("visible");
  } else {
    if (pauseBtn) pauseBtn.classList.add("visible");
  }
}

// --------------------------- Mode UI ---------------------------

function applyModeUI(vm) {
  modeButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === vm.mode);
  });

  if (!manualControls || !workoutNameLabel) return;

  const inputIsFocused =
    manualInputEl && document.activeElement === manualInputEl;

  if (vm.mode === "erg") {
    manualControls.style.display = "inline-flex";

    if (manualInputEl && !inputIsFocused) {
      manualInputEl.value = String(vm.manualErgTarget || 0);
    }

    if (manualUnitEl) manualUnitEl.textContent = "W";
    workoutNameLabel.style.display = "none";
  } else if (vm.mode === "resistance") {
    manualControls.style.display = "inline-flex";

    if (manualInputEl && !inputIsFocused) {
      manualInputEl.value = String(vm.manualResistance || 0);
    }

    if (manualUnitEl) manualUnitEl.textContent = "%";
    workoutNameLabel.style.display = "none";
  } else {
    manualControls.style.display = "none";
    workoutNameLabel.style.display = "flex";
  }
}

function normaliseManualErgValue(raw, vm, currentFtp) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return vm.manualErgTarget || vm.currentFtp || DEFAULT_FTP;
  }
  return Math.min(currentFtp * 2.5, Math.max(50, Math.round(n)));
}

function normaliseManualResistanceValue(raw, vm) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return vm.manualResistance || 0;
  }
  return Math.min(100, Math.max(0, Math.round(n)));
}

function handleManualInputSave() {
  if (!manualInputEl || !engine) return;

  const vm = engine.getViewModel();
  const raw = manualInputEl.value.trim();

  if (vm.mode === "erg") {
    const next = normaliseManualErgValue(raw, vm, vm.currentFtp);
    const current = vm.manualErgTarget || 0;
    const delta = next - current;
    if (delta) {
      engine.adjustManualErg(delta);
    } else {
      manualInputEl.value = String(current);
    }
  } else if (vm.mode === "resistance") {
    const next = normaliseManualResistanceValue(raw, vm);
    const current = vm.manualResistance || 0;
    const delta = next - current;
    if (delta) {
      engine.adjustManualResistance(delta);
    } else {
      manualInputEl.value = String(current);
    }
  }
}

// --------------------------- Status overlay (countdown / paused / resumed) ---------------------------

function updateStatusOverlay(_vm) {
  void _vm; // currently driven via Beeper overlays
}

// --------------------------- Render from engine state ---------------------------

function renderFromEngine(vm) {
  applyModeUI(vm);
  updateWorkoutTitleUI(vm);
  updateStatsDisplay(vm);
  updatePlaybackButtons(vm);
  drawChart(vm);
  updateStatusOverlay(vm);
}

// --------------------------- Theme re-render ---------------------------

function rerenderThemeSensitive() {
  if (!engine) return;
  const vm = engine.getViewModel();
  renderFromEngine(vm);
}

// --------------------------- Load scraped workout ---------------------------

async function handleLastScrapedWorkout() {
  // Concurrency guard: bail if a run is already in progress
  if (isHandlingLastScrapedWorkout) {
    return;
  }

  isHandlingLastScrapedWorkout = true;

  try {
    const [justScraped, last] = await Promise.all([
      wasWorkoutJustScraped(),
      loadLastScrapedWorkout(),
    ]);

    if (!justScraped || !last) return;

    const success = !!last.success;
    const error = last.error || "";
    const title = last.workoutTitle || "(unnamed workout)";

    // -------------------------
    // ❌ Scrape failed → ALERT
    // -------------------------
    if (!success) {
      const msg = [
        `Failed to import workout "${title}".`,
        error ? `\nDetails: ${error}` : ""
      ].join("\n");
      alert(msg);
      return;
    }

    // --------------------------------------
    // 1. Save workout to ZWO library (import)
    // --------------------------------------
    try {
      await picker.saveCanonicalWorkoutToZwoDir(last);
    } catch (err) {
      console.error("[Workout] Failed to save scraped workout:", err);
      alert(
        `Failed to save imported workout "${title}" to your workout folder.\n\n` +
        "Check console for details."
      );
      return; // error path should not continue
    }

    // -----------------------------------------
    // 2. Open the picker focused on this workout
    // -----------------------------------------
    try {
      await openPickerWithGuard(title);
    } catch (err) {
      console.error("[Workout] Failed to open picker:", err);
      alert(
        `Workout "${title}" was imported, but could not be displayed in the picker.\n\n` +
        "Check console for details."
      );
      // continue, it’s still imported
    }

    // ------------------------------------------------------
    // 3. If no active workout, load the new one automatically
    // ------------------------------------------------------
    if (engine) {
      try {
        const vm = engine.getViewModel();
        const hasActive =
          vm.workoutRunning || vm.workoutPaused || vm.workoutStarting;

        if (!hasActive) {
          if (vm.mode !== "workout") {
            engine.setMode("workout");
          }
          engine.setWorkoutFromPicker(last);
        }
      } catch (err) {
        console.error("[Workout] Failed to load workout into engine:", err);
        alert(
          `Workout "${title}" was imported, but could not be loaded as the current workout.\n\n` +
          "Check console for details."
        );
      }
    }
    // ✔️ On success: NO alerts, no prompts, nothing visible except picker
  } catch (err) {
    console.error("[Workout] Unexpected failure:", err);
    alert(
      "A newly imported workout was detected, but an unexpected error occurred.\n\n" +
      "Check console for details."
    );
  } finally {
    try {
      await clearJustScrapedFlag();
    } catch (err) {
      console.error("[Workout] Failed to clear just-scraped flag:", err);
      alert(
        "Imported workout handled, but failed to reset scrape state.\n\n" +
        "Check console for details."
      );
    }
    isHandlingLastScrapedWorkout = false;
  }
}

async function maybeShowWelcome() {
  try {
    if (!hasWelcomeOverlay) {
      setWelcomeActive(false);
      return;
    }

    welcomeTour = initWelcomeTour({
      onFinished: () => {
        if (!welcomeSeenAlready) {
          setWelcomeSeen();
          welcomeSeenAlready = true;
        }
        setWelcomeActive(false);
      },
      onVisibilityChanged: ({isOpen}) => {
        setWelcomeActive(isOpen);
      },
    });

    try {
      welcomeSeenAlready = await hasSeenWelcome();
    } catch (err) {
      logDebug("Welcome seen check failed; treating as first run: " + err);
      welcomeSeenAlready = false;
    }

    if (!welcomeTour || typeof welcomeTour.open !== "function") {
      setWelcomeActive(false);
      hideWelcomeOverlayFallback();
      return;
    }

    setWelcomeActive(true);

    if (welcomeSeenAlready) {
      if (typeof welcomeTour.playSplash === "function") {
        welcomeTour.playSplash(1100);
      } else {
        welcomeTour.open(0);
      }
    } else {
      welcomeTour.open(0);
    }
  } catch (err) {
    console.error("[Workout] Welcome init failed:", err);
    logDebug("Welcome init failed: " + err);
    setWelcomeActive(false);
    hideWelcomeOverlayFallback();
  }
}


// --------------------------- Init ---------------------------

async function initPage() {
  logDebug("Workout page init…");

  setWelcomeActive(isWelcomeActive);
  primeAudioContext();
  const welcomePromise = maybeShowWelcome();

  engine = getWorkoutEngine();

  await engine.init({
    onStateChanged: (vm) => renderFromEngine(vm),
    onLog: logDebug,
    onWorkoutEnded: () => {},
  });

  initBleIntegration();
  updateHrBatteryLabel();

  await initSettings();
  await welcomePromise;

  if (window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => rerenderThemeSensitive();
    if (mql.addEventListener) mql.addEventListener("change", handler);
  }

  picker = getWorkoutPicker({
    overlay: document.getElementById("workoutPickerOverlay"),
    modal: document.getElementById("workoutPickerModal"),
    closeBtn: document.getElementById("workoutPickerCloseBtn"),
    searchInput: document.getElementById("pickerSearchInput"),
    zoneFilter: document.getElementById("pickerZoneFilter"),
    durationFilter: document.getElementById("pickerDurationFilter"),
    summaryEl: document.getElementById("pickerSummary"),
    tbody: document.getElementById("pickerWorkoutTbody"),
    getCurrentFtp: () => engine.getViewModel().currentFtp,
    onWorkoutSelected: (payload) => {
      engine.setWorkoutFromPicker(payload);
    },
  });

  if (workoutNameLabel) {
    workoutNameLabel.dataset.clickable = "true";
    workoutNameLabel.title = "Select a workout (W)";
    workoutNameLabel.addEventListener("click", async () => {
      const vm = engine.getViewModel();
      if (vm.workoutRunning) {
        alert("End the current workout before changing the workout selection.");
        return;
      }
      const name = vm.canonicalWorkout?.workoutTitle;
      await openPickerWithGuard(name);
    });
  }
  if (workoutTitleCenter) {
    workoutTitleCenter.title = "Select a workout (W)";
  }

  if (bikeConnectBtn) {
    bikeConnectBtn.addEventListener("click", async () => {
      const btSupported =
        navigator.bluetooth &&
        typeof navigator.bluetooth.getDevices === "function";
      if (!btSupported) {
        alert("Your browser doesn’t support Bluetooth. Let’s open Settings for options.");
        openSettingsModal();
        return;
      }
      try {
        await BleManager.connectBikeViaPicker();
      } catch (err) {
        logDebug("BLE connect canceled or failed (bike): " + err);
        setBikeStatus("error");
      }
    });
  }

  if (hrConnectBtn) {
    hrConnectBtn.addEventListener("click", async () => {
      const btSupported =
        navigator.bluetooth &&
        typeof navigator.bluetooth.getDevices === "function";
      if (!btSupported) {
        alert("Your browser doesn’t support Bluetooth. Let’s open Settings for options.");
        openSettingsModal();
        return;
      }
      try {
        await BleManager.connectHrViaPicker();
      } catch (err) {
        logDebug("BLE connect canceled or failed (HRM): " + err);
        setHrStatus("error");
      }
    });
  }

  if (modeToggle) {
    modeToggle.addEventListener("click", (e) => {
      const btn = e.target.closest(".mode-toggle-button");
      if (!btn) return;
      const newMode = btn.dataset.mode;
      if (!newMode) return;
      const vm = engine.getViewModel();
      if (newMode === vm.mode) return;
      logDebug(`Mode changed: ${vm.mode} -> ${newMode}`);
      engine.setMode(newMode);
    });
  }

  if (manualControls) {
    manualControls.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".control-btn");
      if (!btn) return;
      const delta = Number(btn.dataset.delta) || 0;
      const vm = engine.getViewModel();
      if (vm.mode === "erg") {
        engine.adjustManualErg(delta);
      } else if (vm.mode === "resistance") {
        engine.adjustManualResistance(delta);
      }
    });
  }

  if (manualInputEl) {
    manualInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleManualInputSave();
        manualInputEl.blur();
      }
    });

    manualInputEl.addEventListener("blur", () => {
      handleManualInputSave();
    });
  }

  if (startBtn) {
    startBtn.addEventListener("click", () => {
      engine.startWorkout();
    });
  }

  if (playBtn) {
    playBtn.addEventListener("click", () => {
      engine.startWorkout();
    });
  }

  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => {
      engine.startWorkout();
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener("click", async () => {
      const sure = confirm("End current workout and save it?");
      if (!sure) return;
      engine.endWorkout();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (isWelcomeActive) return;
    const tag = e.target && e.target.tagName;
    const vm = engine.getViewModel();
    const hasActiveWorkout =
      vm.workoutRunning || vm.workoutPaused || vm.workoutStarting;
    const key = (e.key || "").toLowerCase();
    const modalOpen = isAnyModalOpen();

    if (e.code === "Space") {
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const canToggle =
        vm.mode === "workout" &&
        !!vm.canonicalWorkout;
      if (!canToggle) return;
      e.preventDefault();
      engine.startWorkout();
      return;
    }

    if (!modalOpen && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
      if (key === "w") {
        e.preventDefault();
        if (vm.mode !== "workout") {
          engine.setMode("workout");
          return;
        }
        if (!hasActiveWorkout) {
          const name = vm.canonicalWorkout?.workoutTitle;
          openPickerWithGuard(name);
        }
        return;
      }

      if (key === "e") {
        if (hasActiveWorkout) return;
        e.preventDefault();
        engine.setMode("erg");
        return;
      }

      if (key === "r") {
        if (hasActiveWorkout) return;
        e.preventDefault();
        engine.setMode("resistance");
        return;
      }
    }

    if (e.key === "Escape") {
      if (picker) picker.close();
    }
  });

  adjustStatFontSizes();
  renderFromEngine(engine.getViewModel());

  window.addEventListener("resize", () => {
    adjustStatFontSizes();
    drawChart(engine.getViewModel());
  });

  window.addEventListener("focus", () => {
    handleLastScrapedWorkout().catch((err) => {
      console.error("[Workout] focus scrape check error:", err);
    });
  });

  await handleLastScrapedWorkout();
  logDebug("Workout page ready.");
}

// --------------------------- Boot ---------------------------

document.addEventListener("DOMContentLoaded", () => {
  initPage().catch((err) => {
    console.error("[Workout] init error:", err);
    logDebug("Workout init error: " + err);
  });
});

// --------------------------- PWA Installation ---------------------------

const isExtensionPage = window.location.protocol === "chrome-extension:";
if (!isExtensionPage && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .catch(err => {
        console.error("Service worker registration failed:", err);
      });
  });
}
