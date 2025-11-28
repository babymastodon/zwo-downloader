// workout.js
// UI layer for running a workout against a Wahoo KICKR over BLE.
// All business logic & state is owned by workout-engine.js.
// This file:
//   - wires DOM events to the engine
//   - renders HUD stats, chart, logs
//   - manages picker + sound UI

import {BleManager} from "./ble-manager.js";
import {getWorkoutEngine} from "./workout-engine.js";
import {getWorkoutPicker} from "./workout-picker.js";

import {
  clearSvg,
  renderWorkoutSegmentPolygon,
  attachSegmentHover,
  getCssVar,
  mixColors,
  zoneInfoFromRel,
} from "./workout-chart.js";

import {DEFAULT_FTP} from "./workout-metrics.js";
import {loadSoundPreference, saveSoundPreference, saveFtp} from "./storage.js";

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
const logsBtn = document.getElementById("logsBtn");
const soundBtn = document.getElementById("soundBtn");
const soundIcon = document.getElementById("soundIcon");

const modeToggle = document.getElementById("modeToggle");
const modeButtons = modeToggle
  ? Array.from(modeToggle.querySelectorAll(".mode-toggle-button"))
  : [];

const manualControls = document.getElementById("manualControls");
const manualValueEl = document.getElementById("manualValue");

const workoutControls = document.getElementById("workoutControls");
const startBtn = document.getElementById("startBtn");
const ftpInline = document.getElementById("ftpInline");
const ftpWorkoutValueEl = document.getElementById("ftpWorkoutValue");
const workoutNameLabel = document.getElementById("workoutNameLabel");

const debugOverlay = document.getElementById("debugOverlay");
const debugCloseBtn = document.getElementById("debugCloseBtn");
const debugLog = document.getElementById("debugLog");

const pickerOverlay = document.getElementById("workoutPickerOverlay");
const pickerModal = document.getElementById("workoutPickerModal");
const pickerCloseBtn = document.getElementById("workoutPickerCloseBtn");
const pickerSearchInput = document.getElementById("pickerSearchInput");
const pickerCategoryFilter = document.getElementById("pickerCategoryFilter");
const pickerDurationFilter = document.getElementById("pickerDurationFilter");
const pickerSummaryEl = document.getElementById("pickerSummary");
const pickerWorkoutTbody = document.getElementById("pickerWorkoutTbody");

// --------------------------- UI-local state ---------------------------

let hrBatteryPercent = null;
let soundEnabled = true;

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

  if (debugLog) {
    const isAtBottom =
      debugLog.scrollTop + debugLog.clientHeight >=
      debugLog.scrollHeight - 4;
    debugLog.textContent = logLines.join("\n");
    if (isAtBottom) {
      debugLog.scrollTop = debugLog.scrollHeight;
    }
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

// --------------------------- Sound preference ---------------------------

async function initSoundPreference() {
  soundEnabled = await loadSoundPreference(true);
  updateSoundIcon();
}

function updateSoundIcon() {
  if (!soundBtn || !soundIcon) return;
  if (soundEnabled) {
    soundBtn.classList.add("active");
    soundIcon.innerHTML = `
      <path d="M5 10v4h3l4 4V6l-4 4H5z" />
      <path d="M15 9.5c1 .7 1.6 1.9 1.6 3.1 0 1.2-.6 2.4-1.6 3.1M17.5 7c1.6 1.2 2.5 3.1 2.5 5.1" />
    `;
  } else {
    soundBtn.classList.remove("active");
    soundIcon.innerHTML = `
      <path d="M5 10v4h3l4 4V6l-4 4H5z" />
    `;
  }
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
    vm.lastSampleCadence != null ? String(Math.round(vm.lastSampleCadence)) : "--";

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

// --------------------------- Chart rendering ---------------------------

function drawChart(vm) {
  if (!chartSvg || !chartPanel) return;
  updateChartDimensions();
  clearSvg(chartSvg);

  const w = chartWidth;
  const h = chartHeight;
  chartSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  chartSvg.setAttribute("shape-rendering", "crispEdges");

  const ftp = vm.currentFtp || DEFAULT_FTP;
  const maxY = Math.max(200, ftp * 2);

  // grid
  const step = 100;
  for (let yVal = 0; yVal <= maxY; yVal += step) {
    const y = h - (yVal / maxY) * h;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", "0");
    line.setAttribute("x2", String(w));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("stroke", getCssVar("--grid-line-subtle"));
    line.setAttribute("stroke-width", "0.5");
    line.setAttribute("pointer-events", "none");
    chartSvg.appendChild(line);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", "4");
    label.setAttribute("y", String(y - 6));
    label.setAttribute("font-size", "14");
    label.setAttribute("fill", getCssVar("--text-muted"));
    label.setAttribute("pointer-events", "none");
    label.textContent = String(yVal);
    chartSvg.appendChild(label);
  }

  const totalSec = vm.workoutTotalSec || 1;

  // segments
  if (vm.scaledSegments && vm.scaledSegments.length) {
    vm.scaledSegments.forEach((seg) => {
      renderWorkoutSegmentPolygon({
        svg: chartSvg,
        seg,
        totalSec,
        width: w,
        height: h,
        ftp,
        maxY,
      });
    });
  }

  // past shade
  if (vm.elapsedSec > 0 && totalSec > 0) {
    const xPast = Math.min(w, (vm.elapsedSec / totalSec) * w);
    const shade = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    shade.setAttribute("x", "0");
    shade.setAttribute("y", "0");
    shade.setAttribute("width", String(xPast));
    shade.setAttribute("height", String(h));
    shade.setAttribute("fill", getCssVar("--shade-bg"));
    shade.setAttribute("fill-opacity", "0.05");
    shade.setAttribute("pointer-events", "none");
    chartSvg.appendChild(shade);
  }

  // FTP line
  const ftpY = h - (ftp / maxY) * h;
  const ftpLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  ftpLine.setAttribute("x1", "0");
  ftpLine.setAttribute("x2", String(w));
  ftpLine.setAttribute("y1", String(ftpY));
  ftpLine.setAttribute("y2", String(ftpY));
  ftpLine.setAttribute("stroke", getCssVar("--ftp-line"));
  ftpLine.setAttribute("stroke-width", "1.5");
  ftpLine.setAttribute("pointer-events", "none");
  chartSvg.appendChild(ftpLine);

  const ftpLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  ftpLabel.setAttribute("x", String(w - 4));
  ftpLabel.setAttribute("y", String(ftpY - 6));
  ftpLabel.setAttribute("font-size", "14");
  ftpLabel.setAttribute("fill", getCssVar("--ftp-line"));
  ftpLabel.setAttribute("text-anchor", "end");
  ftpLabel.setAttribute("pointer-events", "none");
  ftpLabel.textContent = `FTP ${ftp}`;
  chartSvg.appendChild(ftpLabel);

  // position line
  const xNow = Math.min(w, (vm.elapsedSec / totalSec) * w);
  const posLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  posLine.setAttribute("x1", String(xNow));
  posLine.setAttribute("x2", String(xNow));
  posLine.setAttribute("y1", "0");
  posLine.setAttribute("y2", String(h));
  posLine.setAttribute("stroke", "#fdd835");
  posLine.setAttribute("stroke-width", "1.5");
  posLine.setAttribute("pointer-events", "none");
  chartSvg.appendChild(posLine);

  // live sample lines
  const samples = vm.liveSamples || [];
  const powerColor = getCssVar("--power-line");
  const hrColor = getCssVar("--hr-line");
  const cadColor = getCssVar("--cad-line");

  if (samples.length) {
    const pathForKey = (key) => {
      let d = "";
      samples.forEach((s) => {
        const t = s.t;
        const val = s[key];
        if (val == null) return;
        const x = Math.min(w, (t / totalSec) * w);
        const yVal = Math.min(maxY, Math.max(0, val));
        const y = h - (yVal / maxY) * h;
        d += (d ? " L " : "M ") + x + " " + y;
      });
      return d;
    };

    const powerPath = pathForKey("power");
    if (powerPath) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", powerPath);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", powerColor);
      p.setAttribute("stroke-width", "2.5");
      p.setAttribute("pointer-events", "none");
      chartSvg.appendChild(p);
    }

    const hrPath = pathForKey("hr");
    if (hrPath) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", hrPath);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", hrColor);
      p.setAttribute("stroke-width", "1.5");
      p.setAttribute("pointer-events", "none");
      chartSvg.appendChild(p);
    }

    const cadPath = pathForKey("cadence");
    if (cadPath) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", cadPath);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", cadColor);
      p.setAttribute("stroke-width", "1.5");
      p.setAttribute("pointer-events", "none");
      chartSvg.appendChild(p);
    }
  }

  attachSegmentHover(chartSvg, chartTooltip, chartPanel);
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

  if (!manualControls || !ftpInline || !workoutNameLabel) return;

  if (vm.mode === "erg") {
    manualControls.style.display = "inline-flex";
    manualValueEl.textContent = String(vm.manualErgTarget || 0);
    ftpInline.style.display = "inline-flex";
    workoutNameLabel.style.display = "flex";
  } else if (vm.mode === "resistance") {
    manualControls.style.display = "inline-flex";
    manualValueEl.textContent = String(vm.manualResistance || 0);
    ftpInline.style.display = "inline-flex";
    workoutNameLabel.style.display = "flex";
  } else {
    manualControls.style.display = "none";
    ftpInline.style.display = "inline-flex";
    workoutNameLabel.style.display = "flex";
  }
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
  saveFtp(clamped);
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

  // BLE, sound, theme
  initBleIntegration();
  await initSoundPreference();
  updateHrBatteryLabel();

  if (window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      rerenderThemeSensitive();
    };
    if (mql.addEventListener) mql.addEventListener("change", handler);
  }

  // Picker singleton
  picker = getWorkoutPicker({
    overlay: pickerOverlay,
    modal: pickerModal,
    closeBtn: pickerCloseBtn,
    searchInput: pickerSearchInput,
    categoryFilter: pickerCategoryFilter,
    durationFilter: pickerDurationFilter,
    summaryEl: pickerSummaryEl,
    tbody: pickerWorkoutTbody,
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

  // FTP click
  if (ftpInline) {
    ftpInline.addEventListener("click", handleFtpClick);
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

  // Logs overlay
  if (logsBtn && debugOverlay && debugLog && debugCloseBtn) {
    logsBtn.addEventListener("click", () => {
      debugOverlay.style.display = "flex";
      debugLog.textContent = logLines.join("\n");
      debugLog.scrollTop = debugLog.scrollHeight;
    });
    debugCloseBtn.addEventListener("click", () => {
      debugOverlay.style.display = "none";
    });
  }

  // Sound toggle
  if (soundBtn) {
    soundBtn.addEventListener("click", () => {
      soundEnabled = !soundEnabled;
      updateSoundIcon();
      saveSoundPreference(soundEnabled);
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
      if (debugOverlay && debugOverlay.style.display !== "none") {
        debugOverlay.style.display = "none";
      }
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

