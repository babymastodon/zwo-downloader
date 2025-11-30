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

import {DEFAULT_FTP, getAdjustedKjForPicker} from "./workout-metrics.js";
import {initSettings, addLogLineToSettings} from "./settings.js";
import {
  loadLastScrapedWorkout,
  wasWorkoutJustScraped,
  clearJustScrapedFlag,
} from "./storage.js";

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

// Track whether a bike is currently connected (via BLE status)
let bikeConnected = false;

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

function buildWorkoutTooltip(vm) {
  const cw = vm && vm.canonicalWorkout;
  if (!cw) return "";

  const currentFtp = vm.currentFtp || cw.baseFtp || DEFAULT_FTP;

  const parts = [];

  if (cw.workoutTitle) {
    parts.push(cw.workoutTitle);
  }

  // Duration (based on workoutTotalSec if available)
  if (vm.workoutTotalSec) {
    const mins = Math.round(vm.workoutTotalSec / 60);
    parts.push(`Duration: ${mins} min`);
  }

  if (cw.category) {
    parts.push(`Category: ${cw.category}`);
  }

  if (typeof cw.ifValue === "number") {
    parts.push(`IF: ${cw.ifValue.toFixed(2)}`);
  }

  if (typeof cw.tss === "number") {
    parts.push(`TSS: ${Math.round(cw.tss)}`);
  }

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

  // Right-side label text/title (even if hidden while running)
  if (workoutNameLabel) {
    if (cw) {
      const name =
        cw.workoutTitle ||
        cw.name || // fallback if CanonicalWorkout still has name
        "Selected workout";
      workoutNameLabel.textContent = name;
      workoutNameLabel.title = name;
    } else {
      workoutNameLabel.textContent = "Click here to select a workout";
      workoutNameLabel.title = "";
    }
  }

  // Center title vs mode toggle & hide right label when running
  if (workoutTitleCenter && modeToggle) {
    if (vm.workoutRunning || vm.workoutStarting) {
      // When workout is started:
      // - hide mode toggle
      // - show bold workout name in center with tooltip
      modeToggle.style.display = "none";
      workoutTitleCenter.style.display = "block";

      const name =
        cw?.workoutTitle ||
        cw?.name ||
        "Workout running";
      workoutTitleCenter.textContent = name;
      workoutTitleCenter.title = buildWorkoutTooltip(vm);

      // Don't show workoutNameLabel on the right while running
      if (workoutNameLabel) {
        workoutNameLabel.style.display = "none";
      }
    } else {
      // Not running: show mode toggle, hide center title
      modeToggle.style.display = "inline-flex";
      workoutTitleCenter.style.display = "none";
      workoutTitleCenter.title = "";
      // Let applyModeUI control workoutNameLabel's display in non-running states
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

  // Tooltip only when we actually have a message
  if (bikeConnectBtn) {
    if (message) {
      bikeConnectBtn.title = message;
    } else {
      bikeConnectBtn.removeAttribute("title");
    }
  }

  bikeStatusDot.classList.remove("connected", "connecting", "error");

  const oldBikeConnected = bikeConnected;
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

  // Refresh chart/placeholder when bike connection status changes
  if (engine && bikeConnected !== oldBikeConnected) {
    const vm = engine.getViewModel();
    drawChart(vm);
  }
}

function setHrStatus({state, message}) {
  if (!hrStatusDot) return;

  // Tooltip only when we actually have a message
  if (hrConnectBtn) {
    if (message) {
      hrConnectBtn.title = message;
    } else {
      hrConnectBtn.removeAttribute("title");
    }
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
    chartEmptyMessage.textContent = "Pedal to begin or click start";
    chartEmptyArrow.classList.add("chart-empty-arrow--right");

  } else if (kind === "resume") {
    chartEmptyMessage.textContent = "Pedal to resume";
    chartEmptyArrow.style.display = "none";   // <-- HIDE ARROW
  }
}

// --------------------------- Chart rendering ---------------------------

function drawChart(vm) {
  if (!chartSvg || !chartPanel) return;

  const showNoBike = !bikeConnected;

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
    bikeConnected &&
    vm &&
    vm.mode === "workout" &&
    !vm.canonicalWorkout &&
    !vm.workoutRunning;

  if (showNoBike) {
    setChartEmptyState("noBike");
  } else if (showResume) {
    setChartEmptyState("resume");
  } else if (showReadyToStart) {
    setChartEmptyState("readyToStart");
  } else if (showNoWorkout) {
    setChartEmptyState("noWorkout");
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
    scaledSegments: vm.scaledSegments,
    totalSec: vm.workoutTotalSec,
    elapsedSec: vm.elapsedSec,
    liveSamples: vm.liveSamples,
    manualErgTarget: vm.manualErgTarget,
  });
}

// --------------------------- Playback buttons ---------------------------

function updatePlaybackButtons(vm) {
  // Hide all buttons first
  [startBtn, playBtn, pauseBtn, stopBtn].forEach(btn => {
    if (btn) btn.classList.remove("visible");
  });

  // No workout selected → show nothing
  if (vm.mode === "workout" && !vm.canonicalWorkout) {
    return;
  }

  // Not running yet → show START
  if (!vm.workoutRunning) {
    if (vm.mode === "workout" && vm.canonicalWorkout && startBtn) {
      startBtn.classList.add("visible");
    }
    return;
  }

  // Running → STOP always visible
  if (stopBtn) stopBtn.classList.add("visible");

  if (vm.workoutPaused) {
    if (playBtn) playBtn.classList.add("visible");   // resume
  } else {
    if (pauseBtn) pauseBtn.classList.add("visible");  // pause
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

    if (manualUnitEl) {
      manualUnitEl.textContent = "W";
    }

    // NEW: hide workout label in ERG mode
    workoutNameLabel.style.display = "none";

  } else if (vm.mode === "resistance") {
    manualControls.style.display = "inline-flex";

    if (manualInputEl && !inputIsFocused) {
      manualInputEl.value = String(vm.manualResistance || 0);
    }

    if (manualUnitEl) {
      manualUnitEl.textContent = "%";
    }

    // NEW: hide workout label in Resistance mode
    workoutNameLabel.style.display = "none";

  } else {
    // Workout mode
    manualControls.style.display = "none";
    workoutNameLabel.style.display = "flex"; // visible in workout mode (when not running)
  }
}

function normaliseManualErgValue(raw, vm, currentFtp) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return vm.manualErgTarget || vm.currentFtp || DEFAULT_FTP;
  }
  // Reasonable ERG bounds
  return Math.min(currentFtp * 2.5, Math.max(50, Math.round(n)));
}

function normaliseManualResistanceValue(raw, vm) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return vm.manualResistance || 0;
  }
  // Resistance as 0–100 %
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
  // Currently driven from Beeper; no-op from UI side for now.
  void _vm;
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
  try {
    const [justScraped, last] = await Promise.all([
      wasWorkoutJustScraped(),
      loadLastScrapedWorkout(),
    ]);

    if (!justScraped || !last) {
      return;
    }

    const name = last.workoutTitle || "(unnamed workout)";
    const success = !!last.success;
    const source = last.source || "";
    const url = last.sourceURL || "";
    const error = last.error || "";

    const baseLines = [];

    baseLines.push(`New workout detected 🎉`);
    baseLines.push(`Title: ${name}`);
    if (source) baseLines.push(`Source: ${source}`);
    if (url) baseLines.push(`URL: ${url}`);

    if (!success || !engine) {
      // If scrape failed or engine isn't ready, just show a friendly message.
      baseLines.push("");
      baseLines.push("Unfortunately we couldn’t load this workout automatically.");
      if (!success && error) {
        baseLines.push("");
        baseLines.push(`Details: ${error}`);
      }
      alert(baseLines.join("\n"));
      return;
    }

    const vm = engine.getViewModel();
    const hasActiveWorkout =
      !!vm &&
      (vm.workoutRunning ||
        vm.workoutPaused ||
        vm.workoutStarting);

    if (!hasActiveWorkout) {
      // No active workout: switch to workout mode if needed and load the new one.
      if (vm.mode !== "workout") {
        engine.setMode("workout");
      }
      engine.setWorkoutFromPicker(last);

      // Also save the scraped workout into the ZWO directory.
      try {
        await picker.saveCanonicalWorkoutToZwoDir(last);
      } catch (err) {
        console.error("[Workout] Failed to save scraped workout to ZWO dir:", err);
      }

      baseLines.push("");
      baseLines.push("This workout has been loaded as your current selection and saved to your workout folder. You can start it whenever you’re ready.");
      alert(baseLines.join("\n"));
    } else {
      // Active workout exists: ask if user wants to end & replace it.
      const replace = confirm(
        "A workout is currently in progress.\n\nDo you want to end it now (it will be saved) and switch to the newly imported workout?"
      );

      if (replace) {
        await engine.endWorkout();

        const vmAfter = engine.getViewModel();
        if (vmAfter.mode !== "workout") {
          engine.setMode("workout");
        }
        engine.setWorkoutFromPicker(last);

        // Also save the scraped workout into the ZWO directory.
        try {
          await saveCanonicalWorkoutToZwoDir(last);
        } catch (err) {
          console.error("[Workout] Failed to save scraped workout to ZWO dir:", err);
        }

        baseLines.push("");
        baseLines.push("Your previous workout was ended and saved.");
        baseLines.push("The newly imported workout has been loaded and saved to your workout folder. You can start it when you’re ready.");
        alert(baseLines.join("\n"));
      } else {
        baseLines.push("");
        baseLines.push("No changes made. Your current workout remains active, and the imported workout was not loaded.");
        alert(baseLines.join("\n"));
      }
    }
  } catch (err) {
    console.error("[Workout] Failed to handle last scraped workout:", err);
    alert(
      "We found a newly imported workout, but something went wrong while trying to load it.\n\n" +
      "If you’re debugging this app, check the console for more details."
    );
  } finally {
    // Ensure the flag is cleared so we only prompt once per scrape
    try {
      await clearJustScrapedFlag();
    } catch (err) {
      console.error("[Workout] Failed to clear just-scraped flag:", err);
    }
  }
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

  // Check if a workout was just scraped and, if so, load/offer to replace
  await handleLastScrapedWorkout();

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

  // Manual text input for ERG / Resistance
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

  // Playback buttons
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      engine.startWorkout();
    });
  }

  if (playBtn) {
    playBtn.addEventListener("click", () => {
      engine.startWorkout(); // resume
    });
  }

  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => {
      engine.startWorkout(); // pause
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener("click", async () => {
      const sure = confirm("End current workout and save it?");
      if (!sure) return;
      engine.endWorkout();
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

  // Re-check on focus (flag ensures we only prompt once per scrape)
  window.addEventListener("focus", () => {
    handleLastScrapedWorkout().catch((err) => {
      console.error("[Workout] focus scrape check error:", err);
    });
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

