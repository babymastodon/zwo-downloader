// workout.js
// Page to run a ZWO workout against a Wahoo KICKR over BLE,
// with ERG / resistance control, HUD stats, chart, auto-pause/resume,
// countdown overlay, paused/resumed overlay, and saving workout JSON.

import {BleManager} from "./ble-manager.js";
import {Beeper} from "./beeper.js";
import {getWorkoutPicker} from "./workout-picker.js";

import {
  computeScaledSegments,
  renderWorkoutSegmentPolygon,
  attachSegmentHover,
  clearSvg,
  getCssVar,
  mixColors,
  zoneInfoFromRel,
} from "./workout-chart.js";

import {DEFAULT_FTP} from "./workout-metrics.js";

import {
  loadWorkoutDirHandle,
  saveWorkoutDirHandle,
  ensureDirPermission,
  loadSelectedWorkout,
  loadActiveState,
  saveActiveState,
  clearActiveState,
  loadSoundPreference,
  saveSoundPreference,
  saveFtp,
} from "./storage.js";

// --------------------------- Constants ---------------------------

// Auto-pause after 1 second of 0 power
const AUTO_PAUSE_POWER_ZERO_SEC = 1;
const AUTO_PAUSE_GRACE_SEC = 15;

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

// --------------------------- State ---------------------------

// Legacy flags and battery values used elsewhere in the UI
let isBikeConnected = false;
let isHrAvailable = false;

let hrBatteryPercent = null;

// workout structure
let workoutMeta = null;
let scaledSegments = [];
let workoutTotalSec = 0;

// live workout
let currentFtp = DEFAULT_FTP;
let mode = "workout"; // "workout" | "erg" | "resistance"
let manualErgTarget = 200;
let manualResistance = 30;

let workoutRunning = false;
let workoutPaused = false;
let workoutStartedAt = null;
let workoutStarting = false;
let elapsedSec = 0;
let currentIntervalIndex = 0;
let intervalElapsedSec = 0;

let lastSamplePower = null;
let lastSampleHr = null;
let lastSampleCadence = null;

let zeroPowerSeconds = 0;
let autoPauseDisabledUntilSec = 0;

// chart
let liveSamples = [];
let chartWidth = 1000;
let chartHeight = 400;

// scheduling
let workoutTicker = null;

// sound
let soundEnabled = true;

// logging
const logLines = [];

// state persistence
let saveStateTimer = null;

// workout dir
let workoutDirHandle = null;

// picker singleton
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

function initBleIntegration() {
  BleManager.on("bikeStatus", (status) => {
    isBikeConnected = status === "connected";
    setBikeStatus(status);
  });

  BleManager.on("hrStatus", (status) => {
    isHrAvailable = status === "connected";
    setHrStatus(status);
  });

  BleManager.on("bikeSample", (sample) => {
    lastSamplePower = sample.power;
    lastSampleCadence = sample.cadence;

    if (!isHrAvailable) {
      lastSampleHr = sample.hrFromBike;
    }

    if (lastSamplePower != null) {
      maybeAutoStartFromPower(lastSamplePower);
    }

    updateStatsDisplay();
  });

  BleManager.on("hrSample", (bpm) => {
    lastSampleHr = bpm;
    updateStatsDisplay();
  });

  BleManager.on("hrBattery", (pct) => {
    hrBatteryPercent = pct;
    updateHrBatteryLabel();
  });

  BleManager.on("log", logDebug);

  BleManager.init({autoReconnect: true});
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

function clampFtp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_FTP;
  return Math.min(500, Math.max(50, Math.round(n)));
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

// --------------------------- Pre-select directory messages ---------------------------

function showWorkoutSaveDirPreselectMessage() {
  alert("Pick the folder where your workout history will be saved.");
}

// --------------------------- Sound preference ---------------------------

async function initSoundPreference() {
  soundEnabled = await loadSoundPreference(true);
  updateSoundIcon();
}

function updateSoundIcon() {
  if (!soundIcon) return;
  if (soundEnabled) {
    soundBtn.classList.add("active");
    soundIcon.innerHTML = `
      <path d="M5 10v4h3l4 4V6l-4 4H5z" />
      <path d="M15 9.5c1 .7 1.6 1.9 1.6 3.1 0 1.2-.6 2.4-1.6 3.1M17.5 7c1.6 1.2 2.5 3.1 2.5 5.1 0 2-1 3.9-2.5 5.1" />
    `;
  } else {
    soundBtn.classList.remove("active");
    soundIcon.innerHTML = `
      <path d="M5 10v4h3l4 4V6l-4 4H5z" />
    `;
  }
}

// --------------------------- Workout structure ---------------------------

function buildScaledSegments() {
  if (!workoutMeta || !Array.isArray(workoutMeta.segmentsForMetrics)) {
    scaledSegments = [];
    workoutTotalSec = 0;
    return;
  }

  const segments = workoutMeta.segmentsForMetrics;
  const ftp = currentFtp || workoutMeta.ftpAtSelection || DEFAULT_FTP;

  const {scaledSegments: scaled, totalSec} = computeScaledSegments(
    segments,
    ftp
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
    (seg.targetWattsEnd - seg.targetWattsStart) * Math.min(1, Math.max(0, rel));

  return {segment: seg, target: Math.round(target)};
}

// --------------------------- Chart rendering ---------------------------

function drawChart() {
  if (!chartSvg) return;
  updateChartDimensions();
  clearSvg(chartSvg);

  const w = chartWidth;
  const h = chartHeight;
  chartSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  chartSvg.setAttribute("shape-rendering", "crispEdges");

  const ftp = currentFtp || DEFAULT_FTP;
  const maxY = Math.max(200, ftp * 2);

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

  const totalSec = workoutTotalSec || 1;

  scaledSegments.forEach((seg) => {
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

  if (elapsedSec > 0 && totalSec > 0) {
    const xPast = Math.min(w, (elapsedSec / totalSec) * w);
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

  const xNow = Math.min(w, (elapsedSec / totalSec) * w);
  const posLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  posLine.setAttribute("x1", String(xNow));
  posLine.setAttribute("x2", String(xNow));
  posLine.setAttribute("y1", "0");
  posLine.setAttribute("y2", String(h));
  posLine.setAttribute("stroke", "#fdd835");
  posLine.setAttribute("stroke-width", "1.5");
  posLine.setAttribute("pointer-events", "none");
  chartSvg.appendChild(posLine);

  const samples = liveSamples;
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

// --------------------------- Stats & HUD ---------------------------

function getCurrentTargetPower() {
  if (mode === "erg") return manualErgTarget;
  if (mode === "resistance") return null;

  if (!scaledSegments.length) return null;

  const t = workoutRunning || elapsedSec > 0 ? elapsedSec : 0;
  const {target} = getCurrentSegmentAtTime(t);
  return target;
}

function getCurrentZoneColor() {
  const ftp = currentFtp || DEFAULT_FTP;
  let refPower;

  if (mode === "workout") {
    const target = getCurrentTargetPower();
    refPower = target || lastSamplePower || ftp * 0.6;
  } else if (mode === "erg") {
    refPower = manualErgTarget || ftp * 0.6;
  } else {
    refPower = (manualResistance / 100) * ftp || ftp * 0.5;
  }

  const rel = refPower / ftp;
  const zone = zoneInfoFromRel(rel);
  return zone.color || getCssVar("--text-main");
}

function updateStatsDisplay() {
  if (lastSamplePower == null) {
    statPowerEl.textContent = "--";
  } else {
    const p = Math.round(lastSamplePower);
    statPowerEl.textContent = String(p < 0 ? 0 : p);
  }

  const target = getCurrentTargetPower();
  statTargetPowerEl.textContent =
    target != null ? String(Math.round(target)) : "--";

  statHrEl.textContent =
    lastSampleHr != null ? String(Math.round(lastSampleHr)) : "--";

  statCadenceEl.textContent =
    lastSampleCadence != null ? String(Math.round(lastSampleCadence)) : "--";

  statElapsedTimeEl.textContent = formatTimeHHMMSS(elapsedSec);
  statIntervalTimeEl.textContent = formatTimeMMSS(intervalElapsedSec);

  let color = getCurrentZoneColor();
  color = mixColors(color, "#000000", 0.3);

  document
    .querySelectorAll(".stat-value span")
    .forEach((el) => (el.style.color = color));
}

// --------------------------- BLE helpers ---------------------------

function setBikeStatus(state) {
  bikeStatusDot.classList.remove("connected", "connecting", "error");
  if (state === "connected") bikeStatusDot.classList.add("connected");
  else if (state === "connecting") bikeStatusDot.classList.add("connecting");
  else if (state === "error") bikeStatusDot.classList.add("error");
}

function setHrStatus(state) {
  hrStatusDot.classList.remove("connected", "connecting", "error");
  if (state === "connected") hrStatusDot.classList.add("connected");
  else if (state === "connecting") hrStatusDot.classList.add("connecting");
  else if (state === "error") hrStatusDot.classList.add("error");
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

// --------------------------- Auto-start helper ---------------------------

function maybeAutoStartFromPower(power) {
  if (!power || power <= 0) return;
  if (mode !== "workout") return;
  if (workoutRunning || workoutStarting) return;
  if (elapsedSec > 0 || liveSamples.length) return;
  if (!scaledSegments.length) {
    if (power >= 75) {
      logDebug("Auto-start (no segments, power >= 75W).");
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
    logDebug(
      `Auto-start: power ${power.toFixed(
        1
      )}W ≥ threshold ${threshold.toFixed(1)}W`
    );
    startWorkout();
  }
}

// --------------------------- Battery reporting ---------------------------

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

// --------------------------- Interval beeps ---------------------------

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
    next.targetWattsStart != null ? next.targetWattsStart / ftp : next.pStartRel;

  if (diffFrac >= 0.3 && nextTargetPct >= 1.2 && secsToEndInt === 9) {
    Beeper.playDangerDanger();
  }

  if (secsToEndInt === 3) {
    Beeper.playBeepPattern();
  }
}

// --------------------------- Workout ticker ---------------------------

function startWorkoutTicker() {
  if (workoutTicker) return;
  workoutTicker = setInterval(async () => {
    const shouldAdvance = workoutRunning && !workoutPaused;

    if (!workoutRunning && !workoutPaused) {
      updateStatsDisplay();
      drawChart();
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
            zeroPowerSeconds >= AUTO_PAUSE_POWER_ZERO_SEC
          ) {
            logDebug("Auto-pause: power at 0 for AUTO_PAUSE_POWER_ZERO_SEC.");
            setWorkoutPaused(true);
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
          logDebug("Auto-resume: power high vs target (>=90%).");
          autoPauseDisabledUntilSec = elapsedSec + AUTO_PAUSE_GRACE_SEC;
          Beeper.showResumedOverlay();
          setWorkoutPaused(false);
        }
      }
    }

    updateStatsDisplay();
    drawChart();
  }, 1000);
}

function stopWorkoutTicker() {
  if (workoutTicker) {
    clearInterval(workoutTicker);
    workoutTicker = null;
  }
}

// --------------------------- Workout save ---------------------------

async function ensureWorkoutDir() {
  if (!("showDirectoryPicker" in window)) {
    alert("Saving workouts requires a recent Chromium-based browser.");
    return null;
  }

  if (!workoutDirHandle) {
    workoutDirHandle = await loadWorkoutDirHandle();
  }

  if (!workoutDirHandle) {
    logDebug("Prompting for workout directory…");

    showWorkoutSaveDirPreselectMessage();

    const handle = await window.showDirectoryPicker();
    const ok = await ensureDirPermission(handle);
    if (!ok) {
      alert("Permission was not granted to the selected folder.");
      return null;
    }
    workoutDirHandle = handle;
    await saveWorkoutDirHandle(handle);
  } else {
    const ok = await ensureDirPermission(workoutDirHandle);
    if (!ok) {
      showWorkoutSaveDirPreselectMessage();
      const handle = await window.showDirectoryPicker();
      const ok2 = await ensureDirPermission(handle);
      if (!ok2) {
        alert("Permission was not granted to the selected folder.");
        return null;
      }
      workoutDirHandle = handle;
      await saveWorkoutDirHandle(handle);
    }
  }

  return workoutDirHandle;
}

async function saveWorkoutFile() {
  if (!workoutMeta || !liveSamples.length) return;

  const dir = await ensureWorkoutDir();
  if (!dir) return;

  const now = new Date();
  const nameSafe =
    workoutMeta.name?.replace(/[<>:"/\\|?*]+/g, "_").slice(0, 60) || "workout";
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
      startedAt: workoutStartedAt ? workoutStartedAt.toISOString() : null,
      endedAt: now.toISOString(),
      totalElapsedSec: elapsedSec,
      modeHistory: "workout",
    },
    samples: liveSamples,
  };

  const text = JSON.stringify(payload, null, 2);
  await writable.write(text);
  await writable.close();

  logDebug(`Workout saved to ${fileName}`);
}

// --------------------------- Active state persistence ---------------------------

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

// --------------------------- FTP clickable / dialog ---------------------------

async function handleFtpClick() {
  if (!ftpInline) return;

  const current = currentFtp || DEFAULT_FTP;
  const input = window.prompt("Set FTP (50–500 W):", String(current));
  if (input == null) return;

  const newFtp = clampFtp(input);
  if (!Number.isFinite(newFtp) || newFtp <= 0) return;
  if (newFtp === currentFtp) return;

  currentFtp = newFtp;
  ftpWorkoutValueEl.textContent = currentFtp;

  buildScaledSegments();
  drawChart();
  updateStatsDisplay();
  scheduleSaveActiveState();

  saveFtp(currentFtp);

  if (picker) {
    picker.syncFtpChanged();
  }

  if (isBikeConnected) {
    sendTrainerState(true).catch((err) =>
      logDebug("Trainer state send after FTP change failed: " + err)
    );
  }
}

// --------------------------- Playback buttons ---------------------------

function updatePlaybackButtons() {
  const existingPlay = document.getElementById("playBtn");
  const existingPause = document.getElementById("pauseBtn");
  const existingStop = document.getElementById("stopBtn");

  if (existingPlay) existingPlay.remove();
  if (existingPause) existingPause.remove();
  if (existingStop) existingStop.remove();

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
      startWorkout();
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
      if (workoutRunning && !workoutPaused) {
        setWorkoutPaused(true);
      }
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
      await endWorkout();
    });
    return btn;
  }

  if (!workoutRunning) {
    if (mode === "workout" && workoutMeta) {
      startBtn.style.display = "";
    } else {
      startBtn.style.display = "none";
    }
    return;
  }

  startBtn.style.display = "none";

  if (mode === "workout") {
    if (workoutPaused) {
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

function setWorkoutRunning(running) {
  workoutRunning = running;
  workoutPaused = !running;
  if (running && !workoutTicker) {
    startWorkoutTicker();
  }
  updatePlaybackButtons();
}

function setWorkoutPaused(paused) {
  workoutPaused = paused;
  if (paused) {
    Beeper.showPausedOverlay();
  }
  updatePlaybackButtons();
}

// --------------------------- Start / stop workout ---------------------------

function startWorkout() {
  if (!workoutMeta || !scaledSegments.length) {
    alert("No workout selected. Choose a workout in the options page.");
    return;
  }

  if (!workoutRunning && !workoutStarting) {
    workoutStarting = true;
    logDebug("Starting workout (countdown)...");
    Beeper.runStartCountdown(async () => {
      liveSamples = [];
      elapsedSec = 0;
      intervalElapsedSec = scaledSegments[0]?.durationSec || 0;
      currentIntervalIndex = 0;
      workoutStartedAt = new Date();
      zeroPowerSeconds = 0;
      autoPauseDisabledUntilSec = elapsedSec + AUTO_PAUSE_GRACE_SEC;

      workoutStarting = false;
      setWorkoutRunning(true);
      setWorkoutPaused(false);
      updateStatsDisplay();
      drawChart();
      await sendTrainerState(true);
      scheduleSaveActiveState();
    });
    return;
  }

  if (workoutPaused) {
    logDebug("Manual resume requested.");
    autoPauseDisabledUntilSec = elapsedSec + AUTO_PAUSE_GRACE_SEC;
    Beeper.showResumedOverlay();
    setWorkoutPaused(false);
  } else {
    logDebug("Manual pause requested.");
    Beeper.showPausedOverlay();
    setWorkoutPaused(true);
  }
}

async function endWorkout() {
  logDebug("Ending workout, saving file if samples exist.");
  stopWorkoutTicker();
  if (liveSamples.length) {
    try {
      await saveWorkoutFile();
    } catch (err) {
      logDebug("Failed to save workout file: " + err);
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
  stopWorkoutTicker();
  clearActiveState();
  updateStatsDisplay();
  drawChart();
  updatePlaybackButtons();
}

// --------------------------- Mode switching ---------------------------

function applyModeUI() {
  modeButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  if (mode === "erg") {
    manualControls.style.display = "inline-flex";
    manualValueEl.textContent = String(manualErgTarget);
    ftpInline.style.display = "inline-flex";
    workoutNameLabel.style.display = "flex";
    if (workoutRunning) setWorkoutPaused(true);
  } else if (mode === "resistance") {
    manualControls.style.display = "inline-flex";
    manualValueEl.textContent = String(manualResistance);
    ftpInline.style.display = "inline-flex";
    workoutNameLabel.style.display = "flex";
    if (workoutRunning) setWorkoutPaused(true);
  } else {
    manualControls.style.display = "none";
    ftpInline.style.display = "inline-flex";
    workoutNameLabel.style.display = "flex";
  }

  updatePlaybackButtons();

  sendTrainerState(true).catch((err) =>
    logDebug("Trainer state send on mode change failed: " + err)
  );
}

// --------------------------- Init & restore ---------------------------

function rerenderThemeSensitive() {
  updateStatsDisplay();
  drawChart();
}

async function initPage() {
  logDebug("Workout page init…");

  initBleIntegration();
  initSoundPreference();

  if (window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      rerenderThemeSensitive();
      if (picker) {
        picker.syncFtpChanged();
      }
    };
    if (mql.addEventListener) mql.addEventListener("change", handler);
  }

  try {
    workoutDirHandle = await loadWorkoutDirHandle();
  } catch (err) {
    logDebug("Failed to load workout dir handle: " + err);
  }

  const selectedWorkout = await loadSelectedWorkout();
  if (!selectedWorkout) {
    workoutNameLabel.textContent = "No workout selected";
    workoutNameLabel.title = "";
    currentFtp = DEFAULT_FTP;
  } else {
    workoutMeta = selectedWorkout;
    const name = workoutMeta.name || "Selected workout";
    workoutNameLabel.textContent = name;
    workoutNameLabel.title = name;
    currentFtp = workoutMeta.ftpAtSelection || DEFAULT_FTP;
  }

  ftpWorkoutValueEl.textContent = currentFtp;

  buildScaledSegments();
  updateChartDimensions();
  drawChart();
  updateStatsDisplay();
  adjustStatFontSizes();

  const activeState = await loadActiveState();
  if (activeState && activeState.workoutMeta && activeState.liveSamples) {
    logDebug("Restoring previous active workout state.");
    workoutMeta = activeState.workoutMeta;
    const name = workoutMeta.name || "Selected workout";
    workoutNameLabel.textContent = name;
    workoutNameLabel.title = name;

    currentFtp = activeState.currentFtp || currentFtp;
    mode = activeState.mode || "workout";
    manualErgTarget = activeState.manualErgTarget || manualErgTarget;
    manualResistance = activeState.manualResistance || manualResistance;
    workoutRunning = !!activeState.workoutRunning;
    workoutPaused = true;
    elapsedSec = activeState.elapsedSec || 0;
    currentIntervalIndex = activeState.currentIntervalIndex || 0;
    liveSamples = activeState.liveSamples || [];
    zeroPowerSeconds = activeState.zeroPowerSeconds || 0;
    autoPauseDisabledUntilSec =
      activeState.autoPauseDisabledUntilSec || 0;
    workoutStartedAt = activeState.workoutStartedAt
      ? new Date(activeState.workoutStartedAt)
      : null;

    ftpWorkoutValueEl.textContent = currentFtp;

    buildScaledSegments();
    updateChartDimensions();
    drawChart();
    updateStatsDisplay();
  }

  modeButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  applyModeUI();

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
    getCurrentFtp: () => currentFtp,
    onWorkoutSelected: (payload) => {
      workoutMeta = payload;
      const name = workoutMeta.name || "Selected workout";
      workoutNameLabel.textContent = name;
      workoutNameLabel.title = name;

      currentFtp = workoutMeta.ftpAtSelection || currentFtp || DEFAULT_FTP;
      ftpWorkoutValueEl.textContent = currentFtp;

      buildScaledSegments();
      elapsedSec = 0;
      intervalElapsedSec = scaledSegments[0]?.durationSec || 0;
      liveSamples = [];
      zeroPowerSeconds = 0;
      autoPauseDisabledUntilSec = 0;
      updateStatsDisplay();
      updatePlaybackButtons();
      drawChart();
      clearActiveState();
    },
    logDebug,
  });

  if (workoutNameLabel) {
    workoutNameLabel.dataset.clickable = "true";
    workoutNameLabel.title = "Click to choose a workout.";
    workoutNameLabel.addEventListener("click", () => {
      if (workoutRunning) {
        alert("End the current workout before changing the workout selection.");
        return;
      }

      picker
        .open()
        .catch?.((err) => {
          logDebug("Workout picker open error: " + err);
        });
    });
  }

  if (ftpInline) {
    ftpInline.addEventListener("click", handleFtpClick);
  }

  bikeConnectBtn.addEventListener("click", async () => {
    if (!navigator.bluetooth) {
      alert("Bluetooth not available in this browser.");
      return;
    }

    try {
      await BleManager.connectBikeViaPicker();
      await sendTrainerState(true);
    } catch (err) {
      logDebug("BLE connect canceled or failed (bike): " + err);
      setBikeStatus("error");
    }
  });

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

  logsBtn.addEventListener("click", () => {
    debugOverlay.style.display = "flex";
    debugLog.textContent = logLines.join("\n");
    debugLog.scrollTop = debugLog.scrollHeight;
  });
  debugCloseBtn.addEventListener("click", () => {
    debugOverlay.style.display = "none";
  });

  soundBtn.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    updateSoundIcon();
    saveSoundPreference(soundEnabled);
  });

  if (modeToggle) {
    modeToggle.addEventListener("click", (e) => {
      const btn = e.target.closest(".mode-toggle-button");
      if (!btn) return;
      const newMode = btn.dataset.mode;
      if (!newMode || newMode === mode) return;
      logDebug(`Mode changed: ${mode} -> ${newMode}`);
      mode = newMode;
      applyModeUI();
      scheduleSaveActiveState();
    });
  }

  manualControls.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".control-btn");
    if (!btn) return;
    const delta = Number(btn.dataset.delta) || 0;
    if (mode === "erg") {
      manualErgTarget = Math.max(50, Math.min(1500, manualErgTarget + delta));
      manualValueEl.textContent = String(manualErgTarget);
    } else if (mode === "resistance") {
      manualResistance = Math.max(0, Math.min(100, manualResistance + delta));
      manualValueEl.textContent = String(manualResistance);
    }
    sendTrainerState(true).catch((err) =>
      logDebug("Trainer state send on manual adjust failed: " + err)
    );
    scheduleSaveActiveState();
  });

  startBtn.addEventListener("click", () => {
    startWorkout();
  });

  document.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (mode !== "workout") return;
      e.preventDefault();
      startWorkout();
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

  if (workoutRunning) {
    startWorkoutTicker();
    setWorkoutPaused(true);
  }

  updatePlaybackButtons();

  window.addEventListener("resize", () => {
    adjustStatFontSizes();
    updateChartDimensions();
    drawChart();
  });

  adjustStatFontSizes();
  drawChart();

  logDebug("Workout page ready.");
}

// --------------------------- Boot ---------------------------

document.addEventListener("DOMContentLoaded", () => {
  initPage().catch((err) => {
    console.error("[Workout] init error:", err);
    logDebug("Workout init error: " + err);
  });
});

