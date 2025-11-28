// workout.js
// UI layer for running a workout against a Wahoo KICKR over BLE.
// All business logic & state is owned by workout-engine.js.
// This file:
//   - wires DOM events to the engine
//   - renders HUD stats, chart
//   - manages picker UI
//   - forwards logs to settings.js for display

import {BleManager} from "./ble-manager.js";
import {getWorkoutEngine} from "./workout-engine.js";
import {getWorkoutPicker} from "./workout-picker.js";

import {
  getCssVar,
  mixColors,
  zoneInfoFromRel,
  drawWorkoutChart,
} from "./workout-chart.js";

import {DEFAULT_FTP} from "./workout-metrics.js";
import {saveFtp} from "./storage.js";
import {initSettings, addLogLineToSettings} from "./settings.js";

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
const manualValueEl = document.getElementById("manualValue");

const workoutControls = document.getElementById("workoutControls");
const startBtn = document.getElementById("startBtn");
const ftpWorkoutValueEl = document.getElementById("ftpWorkoutValue");
const workoutNameLabel = document.getElementById("workoutNameLabel");

// --------------------------- UI-local state ---------------------------

let hrBatteryPercent = null;

const logLines = [];
let chartWidth = 1000;
let chartHeight = 400;

// engine & picker are created in initPage
let engine = null;
let picker = null;

// --------------------------- Helpers ---------------------------

function logDebug(msg) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}`;
  logLines.push(line);
  if (logLines.length > 5000) {
    logLines.splice(0, logLines.length - 5000);
  }
  console.log("[Workout]", msg);

  // Forward to settings modal log view (selection-safe appends happen there)
  try {
    addLogLineToSettings(line);
  } catch (err) {
    // If settings.js isn't ready yet, just ignore; logs are still in console.
    console.error("[Workout] Failed to forward log to settings:", err);
  }
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
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const sss = String(ss).padStart(2, "0");
  return `${hh}:${mm}:${sss}`;
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

function setBikeStatus(state) {
  if (!bikeStatusDot) return;
  bikeStatusDot.classList.remove("connected", "connecting", "error");
  if (state === "connected") bikeStatusDot.classList.add("connected");
  else if (state === "connecting") bikeStatusDot.classList.add("connecting");
  else if (state === "error") bikeStatusDot.classList.add("error");
}

function setHrStatus(state) {
  if (!hrStatusDot) return;
  hrStatusDot.classList.remove("connected", "connecting", "error");
  if (state === "connected") hrStatusDot.classList.add("connected");
  else if (state === "connecting") hrStatusDot.classList.add("connecting");
  else if (state === "error") hrStatusDot.classList.add("error");
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
  // Status LEDs
  BleManager.on("bikeStatus", (status) => {
    setBikeStatus(status);
  });

  BleManager.on("hrStatus", (status) => {
    setHrStatus(status);
  });

  // HR battery is purely UI
  BleManager.on("hrBattery", (pct) => {
    hrBatteryPercent = pct;
    updateHrBatteryLabel();
  });

  BleManager.on("log", logDebug);
}

// --------------------------- Zone color & stats rendering ---------------------------

function getCurrentZoneColor(vm) {
  const ftp = vm.currentFtp || DEFAULT_FTP;
  let refPower;

  if (vm.mode === "workout") {
    const t = vm.elapsedSec > 0 ? vm.elapsedSec : 0;
    let target = null;
    if (vm.scaledSegments && vm.scaledSegments.length) {
      const totalSec = vm.workoutTotalSec || 1;
      const clampedT = Math.min(Math.max(0, t), totalSec);
      let seg = vm.scaledSegments[vm.currentIntervalIndex || 0];
      if (
        !seg ||
        clampedT < seg.startTimeSec ||
        clampedT >= seg.endTimeSec
      ) {
        seg = vm.scaledSegments.find(
          (s) => clampedT >= s.startTimeSec && clampedT < s.endTimeSec
        );
      }
      if (seg) {
        const rel = (clampedT - seg.startTimeSec) / seg.durationSec;
        target =
          seg.targetWattsStart +
          (seg.targetWattsEnd - seg.targetWattsStart) *
          Math.min(1, Math.max(0, rel));
      }
    }
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

  // target power
  let target = null;
  if (vm.mode === "erg") {
    target = vm.manualErgTarget;
  } else if (vm.mode === "workout" && vm.scaledSegments?.length) {
    const totalSec = vm.workoutTotalSec || 1;
    const t = vm.workoutRunning || vm.elapsedSec > 0 ? vm.elapsedSec : 0;
    const clampedT = Math.min(Math.max(0, t), totalSec);
    let seg = vm.scaledSegments[vm.currentIntervalIndex || 0];
    if (
      !seg ||
      clampedT < seg.startTimeSec ||
      clampedT >= seg.endTimeSec
    ) {
      seg = vm.scaledSegments.find(
        (s) => clampedT >= s.startTimeSec && clampedT < s.endTimeSec
      );
    }
    if (seg) {
      const rel = (clampedT - seg.startTimeSec) / seg.durationSec;
      target =
        seg.targetWattsStart +
        (seg.targetWattsEnd - seg.targetWattsStart) *
        Math.min(1, Math.max(0, rel));
    }
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
    statIntervalTimeEl.textContent = formatTimeMMSS(
      vm.intervalElapsedSec || 0
    );
  }

  let color = getCurrentZoneColor(vm);
  color = mixColors(color, "#000000", 0.3);

  document
    .querySelectorAll(".stat-value span")
    .forEach((el) => (el.style.color = color));
}

// --------------------------- Chart rendering ---------------------------

function drawChart(vm) {
  if (!chartSvg || !chartPanel) return;
  updateChartDimensions();

  drawWorkoutChart({
    svg: chartSvg,
    panel: chartPanel,
    tooltipEl: chartTooltip,
    width: chartWidth,
    height: chartHeight,
    ftp: vm.currentFtp || DEFAULT_FTP,
    scaledSegments: vm.scaledSegments,
    totalSec: vm.workoutTotalSec,
    elapsedSec: vm.elapsedSec,
    liveSamples: vm.liveSamples,
  });
}

// --------------------------- Playback buttons ---------------------------

function updatePlaybackButtons(vm) {
  const existingPlay = document.getElementById("playBtn");
  const existingPause = document.getElementById("pauseBtn");
  const existingStop = document.getElementById("stopBtn");

  if (existingPlay) existingPlay.remove();
  if (existingPause) existingPause.remove();
  if (existingStop) existingStop.remove();

  if (!startBtn || !workoutControls) return;

  function createPlayButton() {
    const btn = document.createElement("button");
    btn.id = "playBtn";
    btn.className = "playback-button";
    btn.title = "Start workout (Space)";
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 7v10l8-5z" />
      </svg>`;
    btn.addEventListener("click", () => {
      engine && engine.startWorkout();
    });
    return btn;
  }

  function createPauseButton() {
    const btn = document.createElement("button");
    btn.id = "pauseBtn";
    btn.className = "playback-button";
    btn.title = "Pause workout";
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 7v10M15 7v10" />
      </svg>`;
    btn.addEventListener("click", () => {
      // Pause/resume is handled inside engine.startWorkout toggle;
      // we just treat pause button as "toggle"
      engine && engine.startWorkout();
    });
    return btn;
  }

  function createStopButton() {
    const btn = document.createElement("button");
    btn.id = "stopBtn";
    btn.className = "playback-button";
    btn.title = "End workout";
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="8" y="8" width="8" height="8" />
      </svg>`;
    btn.addEventListener("click", async () => {
      const sure = confirm("End current workout and save it?");
      if (!sure) return;
      engine && engine.endWorkout();
    });
    return btn;
  }

  if (!vm.workoutRunning) {
    // No active workout
    if (vm.mode === "workout" && vm.workoutMeta) {
      startBtn.style.display = "";
    } else {
      startBtn.style.display = "none";
    }
    return;
  }

  startBtn.style.display = "none";

  if (vm.mode === "workout") {
    if (vm.workoutPaused) {
      const play = createPlayButton();
      const stop = createStopButton();
      workoutControls.prepend(stop);
      workoutControls.prepend(play);
    } else {
      const pause = createPauseButton();
      const stop = createStopButton();
      workoutControls.prepend(stop);
      workoutControls.prepend(pause);
    }
  } else {
    const stop = createStopButton();
    workoutControls.prepend(stop);
  }
}

// --------------------------- Mode UI ---------------------------

function applyModeUI(vm) {
  modeButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === vm.mode);
  });

  if (!manualControls || !workoutNameLabel) return;

  if (vm.mode === "erg") {
    manualControls.style.display = "inline-flex";
    manualValueEl.textContent = String(vm.manualErgTarget || 0);
    workoutNameLabel.style.display = "flex";
  } else if (vm.mode === "resistance") {
    manualControls.style.display = "inline-flex";
    manualValueEl.textContent = String(vm.manualResistance || 0);
    workoutNameLabel.style.display = "flex";
  } else {
    manualControls.style.display = "none";
    workoutNameLabel.style.display = "flex";
  }
}

// --------------------------- Status overlay (countdown / paused / resumed) ---------------------------
//
// Engine is responsible for actually showing/hiding the overlay via Beeper,
// but this helper is here if we ever want to tweak styles from UI.
// Leaving placeholder wiring in case engine emits events later.
function updateStatusOverlay(_vm) {
  // Currently driven from Beeper; no-op from UI side for now.
  // Kept for future: could react to vm.workoutPaused / starting countdown, etc.
  void _vm;
}

// --------------------------- Render from engine state ---------------------------

function renderFromEngine(vm) {
  // Workout title & FTP
  if (workoutNameLabel) {
    if (vm.workoutMeta) {
      const name = vm.workoutMeta.name || "Selected workout";
      workoutNameLabel.textContent = name;
      workoutNameLabel.title = name;
    } else {
      workoutNameLabel.textContent = "No workout selected";
      workoutNameLabel.title = "";
    }
  }

  if (ftpWorkoutValueEl) {
    ftpWorkoutValueEl.textContent = vm.currentFtp || DEFAULT_FTP;
  }

  applyModeUI(vm);
  updateStatsDisplay(vm);
  updatePlaybackButtons(vm);
  drawChart(vm);
  updateStatusOverlay(vm);
}

// --------------------------- FTP click handler ---------------------------

async function handleFtpClick() {
  if (!engine) return;
  const vm = engine.getViewModel();
  const current = vm.currentFtp || DEFAULT_FTP;
  const input = window.prompt("Set FTP (50–500 W):", String(current));
  if (input == null) return;

  const n = Number(input);
  if (!Number.isFinite(n)) return;
  const clamped = Math.min(500, Math.max(50, Math.round(n)));
  if (clamped === vm.currentFtp) return;

  engine.setFtp(clamped);
  try {
    saveFtp(clamped);
  } catch (err) {
    console.error("[Workout] Failed to persist FTP:", err);
  }
}

// --------------------------- Theme re-render ---------------------------

function rerenderThemeSensitive() {
  if (!engine) return;
  const vm = engine.getViewModel();
  renderFromEngine(vm);
}

// --------------------------- Init ---------------------------

async function initPage() {
  logDebug("Workout page init…");

  engine = getWorkoutEngine();

  // Initialize engine first so it has state before we wire UI events that call it.
  await engine.init({
    onStateChanged: (vm) => renderFromEngine(vm),
    onLog: logDebug,
    onWorkoutEnded: () => {
      // nothing special for now; HUD re-renders via onStateChanged
    },
  });

  // BLE
  initBleIntegration();
  updateHrBatteryLabel();

  // Settings modal (handles startup checks, dirs, sound, env, logs view)
  await initSettings();

  if (window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      rerenderThemeSensitive();
    };
    if (mql.addEventListener) mql.addEventListener("change", handler);
  }

  // Picker singleton
  picker = getWorkoutPicker({
    overlay: document.getElementById("workoutPickerOverlay"),
    modal: document.getElementById("workoutPickerModal"),
    closeBtn: document.getElementById("workoutPickerCloseBtn"),
    searchInput: document.getElementById("pickerSearchInput"),
    categoryFilter: document.getElementById("pickerCategoryFilter"),
    durationFilter: document.getElementById("pickerDurationFilter"),
    summaryEl: document.getElementById("pickerSummary"),
    tbody: document.getElementById("pickerWorkoutTbody"),
    getCurrentFtp: () => engine.getViewModel().currentFtp,
    onWorkoutSelected: (payload) => {
      engine.setWorkoutFromPicker(payload);
    },
    logDebug,
  });

  // Workout name: click -> picker (guard if workout running)
  if (workoutNameLabel) {
    workoutNameLabel.dataset.clickable = "true";
    workoutNameLabel.title = "Click to choose a workout.";
    workoutNameLabel.addEventListener("click", () => {
      const vm = engine.getViewModel();
      if (vm.workoutRunning) {
        alert("End the current workout before changing the workout selection.");
        return;
      }
      picker
        .open()
        .catch((err) => logDebug("Workout picker open error: " + err));
    });
  }

  // Connect buttons
  if (bikeConnectBtn) {
    bikeConnectBtn.addEventListener("click", async () => {
      if (!navigator.bluetooth) {
        alert("Bluetooth not available in this browser.");
        return;
      }
      try {
        await BleManager.connectBikeViaPicker();
        // engine will push desired state on next relevant change
      } catch (err) {
        logDebug("BLE connect canceled or failed (bike): " + err);
        setBikeStatus("error");
      }
    });
  }

  if (hrConnectBtn) {
    hrConnectBtn.addEventListener("click", async () => {
      if (!navigator.bluetooth) {
        alert("Bluetooth not available in this browser.");
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

  // Mode toggle
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

  // Manual +/- controls
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

  // Start button
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      engine.startWorkout();
    });
  }

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const tag = e.target && e.target.tagName;
    const vm = engine.getViewModel();

    if (e.code === "Space") {
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (vm.mode !== "workout") return;
      e.preventDefault();
      engine.startWorkout();
      return;
    }

    if (e.key === "Escape") {
      if (picker) {
        picker.close();
      }
      // Settings ESC handling is in settings.js
    }
  });

  // Initial layout & chart
  adjustStatFontSizes();
  const vm = engine.getViewModel();
  renderFromEngine(vm);

  // Resize handler
  window.addEventListener("resize", () => {
    adjustStatFontSizes();
    const currentVm = engine.getViewModel();
    drawChart(currentVm);
  });

  logDebug("Workout page ready.");
}

// --------------------------- Boot ---------------------------

document.addEventListener("DOMContentLoaded", () => {
  initPage().catch((err) => {
    console.error("[Workout] init error:", err);
    logDebug("Workout init error: " + err);
  });
});

