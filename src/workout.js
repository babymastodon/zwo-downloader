// workout.js
// Page to run a ZWO workout against a Wahoo KICKR over BLE,
// with ERG / resistance control, HUD stats, chart, auto-pause/resume,
// countdown overlay, paused/resumed overlay, and saving workout JSON.

// --------------------------- Constants / BLE UUIDs ---------------------------

const FTMS_SERVICE_UUID = 0x1826;
const HEART_RATE_SERVICE_UUID = 0x180d;
const BATTERY_SERVICE_UUID = 0x180f;

const INDOOR_BIKE_DATA_CHAR = 0x2ad2;
const FTMS_CONTROL_POINT_CHAR = 0x2ad9;
const HR_MEASUREMENT_CHAR = 0x2a37;
const BATTERY_LEVEL_CHAR = 0x2a19;

// FTMS opcodes (subset)
const FTMS_OPCODES = {
  requestControl: 0x00,
  reset: 0x01,
  setTargetSpeed: 0x02,
  setTargetInclination: 0x03,
  setTargetResistanceLevel: 0x04,
  setTargetPower: 0x05,
  setTargetHeartRate: 0x06,
  startOrResume: 0x07,
  stopOrPause: 0x08,
};

const DEFAULT_FTP = 250;

const DB_NAME = "velo-drive";
const DB_VERSION = 1;
const WORKOUT_DIR_KEY = "workoutDirHandle";
const ZWO_DIR_KEY = "dirHandle"; // same key used in options.js for the ZWO folder


const STORAGE_SELECTED_WORKOUT = "selectedWorkout";
const STORAGE_ACTIVE_STATE = "activeWorkoutState";
const STORAGE_SOUND_ENABLED = "soundEnabled";
const STORAGE_LAST_BIKE_DEVICE_ID = "lastBikeDeviceId";
const STORAGE_LAST_HR_DEVICE_ID = "lastHrDeviceId";
const STORAGE_PICKER_STATE = "pickerState";

// Auto-pause after 1 second of 0 power
const AUTO_PAUSE_POWER_ZERO_SEC = 1;
const AUTO_PAUSE_GRACE_SEC = 15;

const TRAINER_SEND_MIN_INTERVAL_SEC = 10;

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

const statusOverlay = document.getElementById("statusOverlay");
const statusText = document.getElementById("statusText");

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
let isBikeConnecting = false;
let isBikeConnected = false;
let isHrAvailable = false;

let bikeBatteryPercent = null;
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
let workoutStartEpochMs = null;
let workoutStarting = false;
let elapsedSec = 0;
let currentIntervalIndex = 0;
let intervalElapsedSec = 0;

let lastSamplePower = null;
let lastSampleHr = null;
let lastSampleCadence = null;
let lastSampleSpeed = null;
let lastSampleTimeSec = 0;

let zeroPowerSeconds = 0;
let autoPauseDisabledUntilSec = 0;

// chart
let liveSamples = [];
let chartWidth = 1000;
let chartHeight = 400;
let lastHoveredSegment = null;

// scheduling
let workoutTicker = null;

// sound
let soundEnabled = true;
let audioCtx = null;

// logging
const logLines = [];

// state persistence
let saveStateTimer = null;

// workout dir
let dbPromise = null;
let workoutDirHandle = null;

// countdown / overlay
let countdownRunning = false;

// trainer command throttling
let lastTrainerMode = null; // "erg" | "resistance" | null
let lastErgTargetSent = null;
let lastResistanceSent = null;
let lastErgSendTs = 0;
let lastResistanceSendTs = 0;

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
    // Keep your existing UI status state in sync
    isBikeConnected = status === "connected";
    setBikeStatus(status);
  });

  BleManager.on("hrStatus", (status) => {
    isHrAvailable = status === "connected";
    setHrStatus(status);
  });

  // Update live samples used by HUD / auto-start
  BleManager.on("bikeSample", (sample) => {
    if (sample.power != null) lastSamplePower = sample.power;
    if (sample.cadence != null) lastSampleCadence = sample.cadence;
    if (sample.speedKph != null) lastSampleSpeed = sample.speedKph;

    // Only use HR from bike if no dedicated HRM is connected
    if (!isHrAvailable && sample.hrFromBike != null) {
      lastSampleHr = sample.hrFromBike;
    }

    if (lastSamplePower != null) {
      maybeAutoStartFromPower(lastSamplePower);
    }

    updateStatsDisplay();
  });

  BleManager.on("hrSample", (bpm) => {
    if (bpm != null) {
      lastSampleHr = bpm;
      updateStatsDisplay();
    }
  });

  BleManager.on("hrBattery", (pct) => {
    hrBatteryPercent = pct;
    updateHrBatteryLabel();
  });

  // Kick off auto-reconnect if possible
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

function getCssVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

function detectDarkMode() {
  return (
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function parseHexColor(hex) {
  if (!hex) return null;
  let s = hex.trim().toLowerCase();
  if (s.startsWith("#")) s = s.slice(1);
  if (s.length === 3) {
    s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  }
  if (s.length !== 6) return null;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return {r, g, b};
}

function mixColors(hexA, hexB, factor) {
  const a = parseHexColor(hexA);
  const b = parseHexColor(hexB);
  if (!a || !b) return hexA;
  const f = Math.min(1, Math.max(0, factor));
  const r = Math.round(a.r * (1 - f) + b.r * f);
  const g = Math.round(a.g * (1 - f) + b.g * f);
  const bC = Math.round(a.b * (1 - f) + b.b * f);
  const toHex = (x) => x.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(bC)}`;
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

    const isDouble = valueEl.classList.contains('stat-lg');

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

// --------------------------- IndexedDB (workout dir) ---------------------------

function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", {keyPath: "key"});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function saveWorkoutDirHandle(handle) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readwrite");
    const store = tx.objectStore("settings");
    store.put({key: WORKOUT_DIR_KEY, handle});
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadWorkoutDirHandle() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readonly");
    const store = tx.objectStore("settings");
    const req = store.get(WORKOUT_DIR_KEY);
    req.onsuccess = () => {
      resolve(req.result ? req.result.handle : null);
    };
    req.onerror = () => reject(req.error);
  });
}

async function ensureDirPermission(handle) {
  if (!handle || !handle.queryPermission || !handle.requestPermission)
    return false;
  let p = await handle.queryPermission({mode: "readwrite"});
  if (p === "granted") return true;
  if (p === "denied") return false;
  p = await handle.requestPermission({mode: "readwrite"});
  return p === "granted";
}

async function saveZwoDirHandle(handle) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readwrite");
    const store = tx.objectStore("settings");
    store.put({key: ZWO_DIR_KEY, handle});
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadZwoDirHandle() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readonly");
    const store = tx.objectStore("settings");
    const req = store.get(ZWO_DIR_KEY);
    req.onsuccess = () => {
      resolve(req.result ? req.result.handle : null);
    };
    req.onerror = () => reject(req.error);
  });
}

// --------------------------- Pre-select directory messages (placeholders) ---------------------------

function showWorkoutSaveDirPreselectMessage() {
  alert("Pick the folder where your workout history will be saved.");
}

function showZwoDirectoryPreselectMessage() {
  alert("Pick the folder where your .zwo workout files will be saved.");
}


// --------------------------- Storage helpers ---------------------------

function loadSoundPreference() {
  try {
    if (!chrome || !chrome.storage || !chrome.storage.local) {
      updateSoundIcon();
      return;
    }
  } catch {
    updateSoundIcon();
    return;
  }
  chrome.storage.local.get({[STORAGE_SOUND_ENABLED]: true}, (data) => {
    soundEnabled = data.hasOwnProperty(STORAGE_SOUND_ENABLED)
      ? !!data[STORAGE_SOUND_ENABLED]
      : true;
    updateSoundIcon();
  });
}

function persistSoundPreference() {
  try {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
  } catch {
    return;
  }
  chrome.storage.local.set({[STORAGE_SOUND_ENABLED]: soundEnabled});
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

function navigateToOptionsReplace() {
  try {
    if (!chrome || !chrome.runtime) {
      window.location.href = "options.html";
      return;
    }
  } catch {
    window.location.href = "options.html";
    return;
  }
  const url = chrome.runtime.getURL("options.html");
  window.location.replace(url);
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

  const {scaledSegments: scaled, totalSec} = computeScaledSegments(segments, ftp);

  scaledSegments = scaled;
  workoutTotalSec = totalSec;
}


function computeScaledSegments(segments, ftp) {
  let t = 0;
  const scaled = segments.map((seg) => {
    const dur = Math.max(1, Math.round(seg.durationSec || 0));
    const pStartRel = seg.pStartRel || 0;
    const pEndRel = seg.pEndRel != null ? seg.pEndRel : pStartRel;

    const targetWattsStart = Math.round(ftp * pStartRel);
    const targetWattsEnd = Math.round(ftp * pEndRel);

    const s = {
      durationSec: dur,
      startTimeSec: t,
      endTimeSec: t + dur,
      targetWattsStart,
      targetWattsEnd,
      pStartRel,
      pEndRel,
    };

    t += dur;
    return s;
  });

  return {
    scaledSegments: scaled,
    totalSec: t,
  };
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

function zoneInfoFromRel(rel) {
  const clampedRel = Math.max(0, rel);
  const pct = clampedRel * 100;
  let key = "Recovery";
  if (pct < 60) key = "Recovery";
  else if (pct < 76) key = "Base";
  else if (pct < 90) key = "Tempo";
  else if (pct < 105) key = "Threshold";
  else if (pct < 119) key = "VO2Max";
  else key = "Anaerobic";

  const colorVarMap = {
    Recovery: "--zone-recovery",
    Base: "--zone-base",
    Tempo: "--zone-tempo",
    Threshold: "--zone-threshold",
    VO2Max: "--zone-vo2",
    Anaerobic: "--zone-anaerobic",
  };

  const color = getCssVar(colorVarMap[key] || "--zone-recovery");
  const bg = getCssVar("--bg") || "#f4f4f4";

  return {key, color, bg};
}

function clearSvg(svg) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

// Shared helper: canonical segment rendering logic (based on drawChart)
function renderWorkoutSegmentPolygon({
  svg,
  seg,
  totalSec,
  width,
  height,
  ftp,
  maxY,
}) {
  if (!svg || !totalSec || totalSec <= 0) return;

  const w = width;
  const h = height;
  console.log("width height", w, h);

  const x1 = (seg.startTimeSec / totalSec) * w;
  const x2 = (seg.endTimeSec / totalSec) * w;

  const avgRel = (seg.pStartRel + seg.pEndRel) / 2;
  const zone = zoneInfoFromRel(avgRel);

  const p0 = seg.pStartRel * ftp;
  const p1 = seg.pEndRel * ftp;

  const y0 = h - (Math.min(maxY, Math.max(0, p0)) / maxY) * h;
  const y1 = h - (Math.min(maxY, Math.max(0, p1)) / maxY) * h;

  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  const pts = `${x1},${h} ${x1},${y0} ${x2},${y1} ${x2},${h}`;
  poly.setAttribute("points", pts);

  const muted = mixColors(zone.color, zone.bg, 0.3);
  const hover = mixColors(zone.color, zone.bg, 0.15);

  poly.setAttribute("fill", muted);
  poly.setAttribute("fill-opacity", "1");
  poly.setAttribute("stroke", "none");
  poly.classList.add("chart-segment");

  const p0Pct = seg.pStartRel * 100;
  const p1Pct = seg.pEndRel * 100;
  const durMin = seg.durationSec / 60;

  poly.dataset.zone = zone.key;
  poly.dataset.p0 = p0Pct.toFixed(0);
  poly.dataset.p1 = p1Pct.toFixed(0);
  poly.dataset.durMin = durMin.toFixed(1);
  poly.dataset.color = zone.color;
  poly.dataset.mutedColor = muted;
  poly.dataset.hoverColor = hover;

  svg.appendChild(poly);
}

// ===== drawChart using shared segment rendering =====

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

  // use shared segment rendering
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

function attachSegmentHover(svg, tooltipEl, containerEl) {
  if (!svg || !tooltipEl || !containerEl) return;

  svg.addEventListener("mousemove", (e) => {
    const segment = e.target.closest ? e.target.closest(".chart-segment") : null;

    if (!segment) {
      tooltipEl.style.display = "none";
      if (lastHoveredSegment) {
        const prevColor =
          lastHoveredSegment.dataset.mutedColor ||
          lastHoveredSegment.dataset.color;
        if (prevColor) {
          lastHoveredSegment.setAttribute("fill", prevColor);
        }
        lastHoveredSegment = null;
      }
      return;
    }

    const zone = segment.dataset.zone;
    const p0 = segment.dataset.p0;
    const p1 = segment.dataset.p1;
    const durMin = segment.dataset.durMin;

    if (p0 === p1) {
      tooltipEl.textContent = `${zone}: ${p0}% FTP, ${durMin} min`;
    } else {
      tooltipEl.textContent = `${zone}: ${p0}%–${p1}% FTP, ${durMin} min`;
    }
    tooltipEl.style.display = "block";

    const panelRect = containerEl.getBoundingClientRect();
    let tx = e.clientX - panelRect.left + 8;
    let ty = e.clientY - panelRect.top + 8;

    const ttRect = tooltipEl.getBoundingClientRect();
    if (tx + ttRect.width > panelRect.width - 4) {
      tx = panelRect.width - ttRect.width - 4;
    }
    if (tx < 0) tx = 0;
    if (ty + ttRect.height > panelRect.height - 4) {
      ty = panelRect.height - ttRect.height - 4;
    }
    if (ty < 0) ty = 0;

    tooltipEl.style.left = `${tx}px`;
    tooltipEl.style.top = `${ty}px`;

    if (lastHoveredSegment && lastHoveredSegment !== segment) {
      const prevColor =
        lastHoveredSegment.dataset.mutedColor ||
        lastHoveredSegment.dataset.color;
      if (prevColor) {
        lastHoveredSegment.setAttribute("fill", prevColor);
      }
    }

    const hoverColor =
      segment.dataset.hoverColor ||
      segment.dataset.color ||
      segment.dataset.mutedColor;
    if (hoverColor) {
      segment.setAttribute("fill", hoverColor);
    }

    lastHoveredSegment = segment;
  });

  svg.addEventListener("mouseleave", () => {
    tooltipEl.style.display = "none";
    if (lastHoveredSegment) {
      const prevColor =
        lastHoveredSegment.dataset.mutedColor ||
        lastHoveredSegment.dataset.color;
      if (prevColor) {
        lastHoveredSegment.setAttribute("fill", prevColor);
      }
      lastHoveredSegment = null;
    }
  });
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
  color = mixColors(color, "#000000", 0.30);

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
  // No hardware check here; BleManager knows if it's connected or not.
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

// --------------------------- Audio / overlay ---------------------------

// Beeper singleton
const Beeper = (() => {
  let audioCtx = null;
  let enabled = true;
  let currentNodes = [];
  let countdownRunning = false;
  let timeouts = [];

  // ---------------------------------------------------------------------------
  // Timeout management
  // ---------------------------------------------------------------------------

  function addTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    timeouts.push(id);
    return id;
  }

  function clearAllTimeouts() {
    timeouts.forEach(id => clearTimeout(id));
    timeouts = [];
  }

  // ---------------------------------------------------------------------------
  // Core audio plumbing
  // ---------------------------------------------------------------------------

  function ensureAudioContext() {
    if (!audioCtx) {
      const AC = window.AudioContext;
      if (!AC) {
        console.warn("Web Audio API not supported");
        return null;
      }
      audioCtx = new AC();
    }
    return audioCtx;
  }

  function track(n) {
    if (n) currentNodes.push(n);
    return n;
  }

  function stopCurrent() {
    if (!audioCtx) {
      currentNodes = [];
      return;
    }
    currentNodes.forEach(node => {
      try {if (node.stop) node.stop(audioCtx.currentTime + 0.01);} catch {}
      try {if (node.disconnect) node.disconnect();} catch {}
    });
    currentNodes = [];
  }

  // Full stop: audio + scheduled audio + overlay state
  function stopAll() {
    clearAllTimeouts();
    stopCurrent();
    countdownRunning = false;
    if (typeof statusOverlay !== "undefined" && statusOverlay) {
      statusOverlay.style.opacity = "0";
      statusOverlay.style.display = "none";
    }
  }

  // Public audio toggle: only affects sound (not overlays / timeouts)
  function setEnabled(flag) {
    enabled = !!flag;
    if (!enabled) stopCurrent();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function createMasterGain(ctx, startTime, totalSec, fadeInSec = 0.03, fadeOutSec = 0.1) {
    const g = track(ctx.createGain());
    g.gain.value = 0.0001;
    g.connect(ctx.destination);

    const end = startTime + totalSec;
    g.gain.setValueAtTime(0.0001, startTime);
    g.gain.linearRampToValueAtTime(1.0, startTime + fadeInSec);
    g.gain.setValueAtTime(1.0, end - fadeOutSec);
    g.gain.linearRampToValueAtTime(0.0001, end);
    return g;
  }

  // Private: show overlay with computed styles
  function showOverlay(text, fontSizePx) {
    if (!statusOverlay || !statusText) return;

    statusOverlay.style.display = "flex";
    statusText.textContent = text;
    statusText.style.fontSize = `${fontSizePx}px`;

    void statusOverlay.offsetWidth;
    statusOverlay.style.opacity = "1";
  }

  // ---------------------------------------------------------------------------
  // PRIVATE: simple beep (no stopping here)
  // ---------------------------------------------------------------------------

  function playBeep(durationMs = 120, freq = 880, gain = 0.75) {
    if (!enabled) return;
    const ctx = ensureAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const durSec = durationMs / 1000;

    const osc = track(ctx.createOscillator());
    const g = track(ctx.createGain());

    osc.type = "square";
    osc.frequency.value = freq;

    g.gain.value = 0.0001;
    osc.connect(g);
    g.connect(ctx.destination);

    const attack = 0.005;
    const release = 0.03;
    const end = now + durSec;

    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gain, now + attack);
    g.gain.setValueAtTime(gain, Math.max(now + attack, end - release));
    g.gain.linearRampToValueAtTime(0.0001, end);

    osc.start(now);
    osc.stop(end + 0.05);
  }

  // ---------------------------------------------------------------------------
  // PRIVATE: AIR RAID SIREN + MEGA HONK (no stopping here)
  // ---------------------------------------------------------------------------

  function playAirRaidSiren(
    cycles = 3,
    rampDurationSec = 3,
    baseFreq = 110,
    topFreq = 1400,
    gain = 0.28
  ) {
    if (!enabled) return 0;
    const ctx = ensureAudioContext();
    if (!ctx) return 0;

    const now = ctx.currentTime;
    const totalSec = cycles * rampDurationSec;
    const endTime = now + totalSec;

    const masterGain = createMasterGain(ctx, now, totalSec, 0.05, 0.1);

    const sirenGain = track(ctx.createGain());
    sirenGain.gain.value = 0.0001;
    sirenGain.connect(masterGain);

    sirenGain.gain.setValueAtTime(0.0001, now);
    sirenGain.gain.linearRampToValueAtTime(gain, now + 0.3);
    sirenGain.gain.setValueAtTime(gain, endTime - 0.3);
    sirenGain.gain.linearRampToValueAtTime(0.0001, endTime);

    const voices = [
      {octave: 0.25, detune: -4},
      {octave: 0.5, detune: +3},
      {octave: 1.0, detune: -2},
      {octave: 2.0, detune: +6}
    ];

    function scheduleRamp(osc, base, top, start, dur) {
      const rEnd = start + dur;
      osc.frequency.setValueAtTime(base, start);
      osc.frequency.linearRampToValueAtTime(top, rEnd);
      osc.frequency.setValueAtTime(base, rEnd);
    }

    voices.forEach(v => {
      const osc = track(ctx.createOscillator());
      osc.type = "sawtooth";
      osc.detune.value = v.detune;
      osc.connect(sirenGain);

      for (let i = 0; i < cycles; i++) {
        const t0 = now + i * rampDurationSec;
        scheduleRamp(
          osc,
          baseFreq * v.octave,
          topFreq * v.octave,
          t0,
          rampDurationSec
        );
      }

      osc.start(now);
      osc.stop(endTime + 0.05);
    });

    return totalSec;
  }

  function playMegaHonk(
    totalDurationSec = 9,
    honkDurationSec = 0.36,
    gapSec = 0.18,
    baseFreq = 320,
    gain = 0.6
  ) {
    if (!enabled) return 0;
    const ctx = ensureAudioContext();
    if (!ctx) return 0;

    const now = ctx.currentTime;
    const end = now + totalDurationSec;

    const masterGain = createMasterGain(ctx, now, totalDurationSec, 0.04, 0.1);

    const voiceGain = track(ctx.createGain());
    voiceGain.gain.value = 0.0001;
    voiceGain.connect(masterGain);

    voiceGain.gain.setValueAtTime(0.0001, now);
    voiceGain.gain.linearRampToValueAtTime(gain, now + 0.05);
    voiceGain.gain.setValueAtTime(gain, end - 0.15);
    voiceGain.gain.linearRampToValueAtTime(0.0001, end);

    const voiceDefs = [
      {type: "sawtooth", freqMul: 0.5, detune: -8},
      {type: "sawtooth", freqMul: 1.0, detune: 0},
      {type: "square", freqMul: 2.0, detune: +4},
      {type: "sawtooth", freqMul: 3.0, detune: -4},
      {type: "square", freqMul: 5.0, detune: 0},
      {type: "square", freqMul: 6.5, detune: +6},
      {type: "square", freqMul: 8.0, detune: -6}
    ];

    const voices = voiceDefs.map(v => {
      const osc = track(ctx.createOscillator());
      osc.type = v.type;
      osc.detune.value = v.detune;
      osc.frequency.value = baseFreq * v.freqMul;
      osc.connect(voiceGain);
      osc.start(now);
      osc.stop(end + 0.1);
      return {osc, freqMul: v.freqMul};
    });

    const attack = 0.01;
    const punchDrop = 0.06;
    const releaseTail = 0.08;
    const pitchEnvTime = 0.08;

    let t = now;
    while (t < end) {
      const hs = t;
      const he = hs + honkDurationSec;
      if (hs >= end) break;
      const safeEnd = Math.min(he, end);

      const peak = gain * 1.2;
      const sustain = gain * 0.85;

      voiceGain.gain.setValueAtTime(0.0001, hs);
      voiceGain.gain.linearRampToValueAtTime(peak, hs + attack);
      voiceGain.gain.linearRampToValueAtTime(sustain, hs + punchDrop);
      voiceGain.gain.setValueAtTime(
        sustain,
        Math.max(hs + punchDrop, safeEnd - releaseTail)
      );
      voiceGain.gain.linearRampToValueAtTime(0.0001, safeEnd);

      voices.forEach(({osc, freqMul}) => {
        const base = baseFreq * freqMul;
        if (freqMul <= 1.0) {
          osc.frequency.setValueAtTime(base * 1.06, hs);
          osc.frequency.linearRampToValueAtTime(
            base,
            Math.min(hs + pitchEnvTime, safeEnd)
          );
        } else {
          osc.frequency.setValueAtTime(base * 0.96, hs);
          osc.frequency.linearRampToValueAtTime(
            base * 1.02,
            Math.min(hs + pitchEnvTime * 0.8, safeEnd)
          );
        }
      });

      t += honkDurationSec + gapSec;
    }

    voiceGain.gain.setValueAtTime(0.0001, end);
    return totalDurationSec;
  }

  // ---------------------------------------------------------------------------
  // PUBLIC: Beep pattern – directly calls playBeep via scheduled timeouts
  // ---------------------------------------------------------------------------

  function playBeepPattern(
    shortCount = 3,
    shortDurationMs = 120,
    shortFreq = 880,
    longDurationMs = 500,
    longFreq = 660,
    spacingSec = 1.0,
    gain = 0.75
  ) {
    if (!enabled) return;
    if (!ensureAudioContext()) return;

    // Public entrypoint: fully reset previous audio/schedules
    stopAll();

    for (let i = 0; i < shortCount; i++) {
      const offsetMs = i * spacingSec * 1000;
      addTimeout(() => {
        playBeep(shortDurationMs, shortFreq, gain);
      }, offsetMs);
    }

    const longOffsetMs = shortCount * spacingSec * 1000;
    addTimeout(() => {
      playBeep(longDurationMs, longFreq, gain);
    }, longOffsetMs);
  }

  // ---------------------------------------------------------------------------
  // PUBLIC: Paused / Resumed overlays
  // ---------------------------------------------------------------------------

  function showStatusMessage(text, heightRatio = 0.2, durationMs = 800) {
    if (!statusOverlay || !statusText) return;
    const totalHeight = window.innerHeight || 800;
    const fontSize = Math.floor(totalHeight * heightRatio);

    showOverlay(text, fontSize);

    addTimeout(() => {
      statusOverlay.style.opacity = "0";
      addTimeout(() => {
        statusOverlay.style.display = "none";
      }, 300);
    }, durationMs);
  }

  function showPausedOverlay() {
    showStatusMessage("Workout Paused", 0.2, 1600);
  }

  function showResumedOverlay() {
    showStatusMessage("Workout Resumed", 0.2, 1600);
  }

  // ---------------------------------------------------------------------------
  // PUBLIC: Start countdown – now stops existing first
  // ---------------------------------------------------------------------------

  function runStartCountdown(onDone) {
    if (!statusOverlay || !statusText) {
      onDone && onDone();
      return;
    }

    // Reset any previous countdown/audio/overlay state
    stopAll();

    countdownRunning = true;
    const seq = ["3", "2", "1", "Start"];
    const totalHeight = window.innerHeight || 800;
    const fontSize = Math.floor(totalHeight * 0.25);

    const step = idx => {
      if (!countdownRunning) return;

      if (idx >= seq.length) {
        statusOverlay.style.opacity = "0";
        addTimeout(() => {
          statusOverlay.style.display = "none";
          countdownRunning = false;
          onDone && onDone();
        }, 200);
        return;
      }

      const label = seq[idx];
      showOverlay(label, fontSize);

      // Beep per step using same primitive as patterns
      if (label === "Start") {
        playBeep(220, 660, 0.75);
      } else {
        playBeep(120, 880, 0.75);
      }

      addTimeout(() => {
        statusOverlay.style.opacity = "0";
      }, 500);

      addTimeout(() => step(idx + 1), 1000);
    };

    step(0);
  }

  // ---------------------------------------------------------------------------
  // PUBLIC: DangerDanger — siren followed by mega honk
  // ---------------------------------------------------------------------------

  function playDangerDanger() {
    if (!enabled) return;
    if (!ensureAudioContext()) return;

    // Reset any previous sequences first
    stopAll();

    const sirenDurationSec = playAirRaidSiren();
    if (sirenDurationSec <= 0) return;

    addTimeout(() => {
      playMegaHonk();
    }, sirenDurationSec * 1000 + 50);
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  return {
    setEnabled,
    stop: stopAll,
    playBeepPattern,
    runStartCountdown,
    showPausedOverlay,
    showResumedOverlay,
    playDangerDanger
  };
})();

// --------------------------- BLE singleton ---------------------------

const BleManager = (() => {
  // Local constants (self-contained – these shadow the globals safely)
  const FTMS_SERVICE_UUID = 0x1826;
  const HEART_RATE_SERVICE_UUID = 0x180d;
  const BATTERY_SERVICE_UUID = 0x180f;

  const INDOOR_BIKE_DATA_CHAR = 0x2ad2;
  const FTMS_CONTROL_POINT_CHAR = 0x2ad9;
  const HR_MEASUREMENT_CHAR = 0x2a37;
  const BATTERY_LEVEL_CHAR = 0x2a19;

  const FTMS_OPCODES = {
    requestControl: 0x00,
    reset: 0x01,
    setTargetSpeed: 0x02,
    setTargetInclination: 0x03,
    setTargetResistanceLevel: 0x04,
    setTargetPower: 0x05,
    setTargetHeartRate: 0x06,
    startOrResume: 0x07,
    stopOrPause: 0x08,
  };

  const TRAINER_SEND_MIN_INTERVAL_SEC = 10;
  const STORAGE_LAST_BIKE_DEVICE_ID = "lastBikeDeviceId";
  const STORAGE_LAST_HR_DEVICE_ID = "lastHrDeviceId";

  // Simple event system
  const listeners = {
    log: new Set(),
    bikeStatus: new Set(),
    hrStatus: new Set(),
    bikeSample: new Set(),
    hrSample: new Set(),
    hrBattery: new Set(),
  };

  function emit(type, payload) {
    const set = listeners[type];
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error("[BleManager] listener error for", type, err);
      }
    }
  }

  function log(msg) {
    // Forward to workout logger if available
    if (typeof logDebug === "function") {
      logDebug(msg);
    } else {
      console.log("[BleManager]", msg);
    }
    emit("log", msg);
  }

  // Internal device state
  const bikeState = {
    device: null,
    server: null,
    ftmsService: null,
    indoorBikeDataChar: null,
    controlPointChar: null,
    _disconnectHandler: null,
  };

  const hrState = {
    device: null,
    server: null,
    hrService: null,
    measurementChar: null,
    batteryService: null,
    _disconnectHandler: null,
  };

  // Connection flags (internal)
  let bikeConnected = false;
  let hrConnected = false;

  function updateBikeStatus(state) {
    bikeConnected = state === "connected";
    emit("bikeStatus", state);
  }

  function updateHrStatus(state) {
    hrConnected = state === "connected";
    emit("hrStatus", state);
  }

  // Last samples & battery
  let lastBikeSample = {
    power: null,
    cadence: null,
    speedKph: null,
    hrFromBike: null,
  };

  let hrBatteryPercent = null;

  // Trainer throttling
  let lastTrainerMode = null; // "erg" | "resistance" | null
  let lastErgTargetSent = null;
  let lastResistanceSent = null;
  let lastErgSendTs = 0;
  let lastResistanceSendTs = 0;

  function nowSec() {
    return performance.now() / 1000;
  }

  // ---------------------------------------------------------------------------
  // Storage helpers for device IDs
  // ---------------------------------------------------------------------------

  function loadSavedBleDeviceIds() {
    return new Promise((resolve) => {
      try {
        if (!chrome || !chrome.storage || !chrome.storage.local) {
          resolve({bikeId: null, hrId: null});
          return;
        }
      } catch {
        resolve({bikeId: null, hrId: null});
        return;
      }

      chrome.storage.local.get(
        {
          [STORAGE_LAST_BIKE_DEVICE_ID]: null,
          [STORAGE_LAST_HR_DEVICE_ID]: null,
        },
        (data) => {
          resolve({
            bikeId: data[STORAGE_LAST_BIKE_DEVICE_ID],
            hrId: data[STORAGE_LAST_HR_DEVICE_ID],
          });
        }
      );
    });
  }

  function saveBikeDeviceId(id) {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.set({[STORAGE_LAST_BIKE_DEVICE_ID]: id});
    } catch {}
  }

  function saveHrDeviceId(id) {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.set({[STORAGE_LAST_HR_DEVICE_ID]: id});
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Retry helper
  // ---------------------------------------------------------------------------

  // Helper: detect when the error is really "GATT is gone, stop retrying"
  function isGattDisconnectedError(err) {
    if (!err) return false;

    const name = err.name || "";
    const msg = String(err.message || err).toLowerCase();

    // Web Bluetooth tends to use NetworkError with this message
    if (msg.includes("gatt server is disconnected")) {
      return true;
    }

    // Be conservative: some stacks use these names for "not connected"
    if (
      name === "NetworkError" ||
      name === "NotConnectedError" ||
      name === "InvalidStateError"
    ) {
      // Only treat as fatal if message suggests disconnection
      if (
        msg.includes("gatt") &&
        (msg.includes("disconnect") || msg.includes("not connected"))
      ) {
        return true;
      }
    }

    return false;
  }

  function isConnectInProgressError(err) {
    if (!err) return false;
    const msg = String(err.message || err).toLowerCase();
    const name = err.name || "";
    return (
      msg.includes("connection already in progress") ||
      (name === "NetworkError" && msg.includes("already in progress"))
    );
  }

  // Retry a Bluetooth operation up to `retries` times with exponential backoff,
  // but abort immediately once we know the GATT server is disconnected.
  async function btRetry(fn, retries = 8, baseDelay = 1000) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;

        if (isGattDisconnectedError(err) || isConnectInProgressError(err)) {
          logDebug &&
            logDebug(
              `btRetry: aborting retries for non-retriable error: ${err}`
            );
          break; // stop retry loop; caller will see the error
        }

        const delay = baseDelay * Math.pow(1.2, attempt - 1);
        logDebug &&
          logDebug(
            `btRetry: attempt ${attempt} failed: ${err}. Retrying in ${delay}ms`
          );
        await new Promise((res) => setTimeout(res, delay));
      }
    }
    throw lastErr;
  }


  // ---------------------------------------------------------------------------
  // Auto-reconnect queue
  // ---------------------------------------------------------------------------

  let reconnectQueue = [];
  let reconnectWorkerActive = false;

  function enqueueReconnect(kind) {
    reconnectQueue.push(kind);
    if (!reconnectWorkerActive) {
      processReconnectQueue().catch((err) =>
        log("Reconnect worker error: " + err)
      );
    }
  }

  function clearReconnectQueue() {
    reconnectQueue = [];
    log("Reconnect queue cleared (manual connect).");
  }

  async function processReconnectQueue() {
    reconnectWorkerActive = true;
    try {
      while (reconnectQueue.length) {
        const kind = reconnectQueue.shift();

        if (kind === "bike") {
          if (!bikeState.device || bikeConnected) continue;
          log("Auto-reconnect: attempting bike reconnect…");
          updateBikeStatus("connecting");
          try {
            await connectToBike(bikeState.device);
            log("Auto-reconnect (bike) succeeded.");
          } catch (err) {
            log("Auto-reconnect (bike) failed: " + err);
            updateBikeStatus("error");
          }
        } else if (kind === "hr") {
          if (!hrState.device || hrConnected) continue;
          log("Auto-reconnect: attempting HRM reconnect…");
          updateHrStatus("connecting");
          try {
            await connectToHr(hrState.device);
            log("Auto-reconnect (HRM) succeeded.");
          } catch (err) {
            log("Auto-reconnect (HRM) failed: " + err);
            updateHrStatus("error");
          }
        }

        await new Promise((res) => setTimeout(res, 2000));
      }
    } finally {
      reconnectWorkerActive = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Parsing helpers
  // ---------------------------------------------------------------------------

  function parseIndoorBikeData(dataView) {
    if (!dataView || dataView.byteLength < 4) return;

    let index = 0;
    const flags = dataView.getUint16(index, true);
    index += 2;

    // Speed (km/h)
    if ((flags & 0x0001) === 0 && dataView.byteLength >= index + 2) {
      const raw = dataView.getUint16(index, true);
      index += 2;
      lastBikeSample.speedKph = raw / 100.0;
    }

    if (flags & (1 << 1)) index += 2;

    // Cadence
    if (flags & (1 << 2)) {
      if (dataView.byteLength >= index + 2) {
        const rawCad = dataView.getUint16(index, true);
        index += 2;
        lastBikeSample.cadence = rawCad / 2.0;
      }
    }

    if (flags & (1 << 3)) index += 2;
    if (flags & (1 << 4)) index += 3;
    if (flags & (1 << 5)) index += 1;

    // Power
    if (flags & (1 << 6)) {
      if (dataView.byteLength >= index + 2) {
        const power = dataView.getInt16(index, true);
        index += 2;
        lastBikeSample.power = power;
      }
    }

    if (flags & (1 << 7)) index += 2;
    if (flags & (1 << 8)) index += 5;

    // HR from bike (optional)
    if (flags & (1 << 9)) {
      if (dataView.byteLength >= index + 1) {
        const hr = dataView.getUint8(index);
        index += 1;
        lastBikeSample.hrFromBike = hr;
      }
    }

    log(
      `FTMS <- IndoorBikeData: flags=0x${flags
        .toString(16)
        .padStart(4, "0")}, power=${lastBikeSample.power ?? "n/a"}W, cad=${lastBikeSample.cadence != null ? lastBikeSample.cadence.toFixed(1) : "n/a"
      }rpm`
    );

    emit("bikeSample", {...lastBikeSample});
  }

  function parseHrMeasurement(dataView) {
    if (!dataView || dataView.byteLength < 2) return;

    let offset = 0;
    const flags = dataView.getUint8(offset);
    offset += 1;
    const is16bit = (flags & 0x1) !== 0;

    let hr;
    if (is16bit && dataView.byteLength >= offset + 2) {
      hr = dataView.getUint16(offset, true);
    } else if (!is16bit) {
      hr = dataView.getUint8(offset);
    }

    log(`HRM <- HeartRateMeasurement: hr=${hr}bpm`);
    emit("hrSample", hr);
  }

  // ---------------------------------------------------------------------------
  // FTMS control point / trainer state
  // ---------------------------------------------------------------------------

  async function sendFtmsControlPoint(opCode, sint16Param /* or null */) {
    const cpChar = bikeState.controlPointChar;
    if (!cpChar) {
      log("FTMS CP write attempted, but control point characteristic not ready.");
      throw new Error("FTMS Control Point characteristic not ready");
    }

    let buffer;
    if (sint16Param == null) {
      buffer = new Uint8Array([opCode]).buffer;
    } else {
      buffer = new ArrayBuffer(3);
      const view = new DataView(buffer);
      view.setUint8(0, opCode);
      view.setInt16(1, sint16Param, true);
    }

    log(
      `FTMS CP -> opCode=0x${opCode.toString(16)}, param=${sint16Param ?? "none"}`
    );

    const fn = cpChar.writeValueWithResponse || cpChar.writeValue;
    await fn.call(cpChar, buffer);
  }

  async function sendErgSetpointRaw(targetWatts) {
    if (!bikeState.controlPointChar) return;
    const val = Math.max(0, Math.min(2000, targetWatts | 0));
    try {
      await sendFtmsControlPoint(FTMS_OPCODES.setTargetPower, val);
      log(`ERG target → ${val} W`);
    } catch (err) {
      log("Failed to set ERG target: " + err);
    }
  }

  async function sendResistanceLevelRaw(level) {
    if (!bikeState.controlPointChar) return;
    const clamped = Math.max(0, Math.min(100, level | 0));
    const tenth = clamped * 10;
    try {
      await sendFtmsControlPoint(FTMS_OPCODES.setTargetResistanceLevel, tenth);
      log(`Resistance level → ${clamped}`);
    } catch (err) {
      log("Failed to set resistance: " + err);
    }
  }

  async function setTrainerStateInternal(state, {force = false} = {}) {
    if (!bikeConnected || !bikeState.controlPointChar) return;

    const tNow = nowSec();

    if (state.kind === "erg") {
      const target = Math.round(state.value);
      const needsSend =
        force ||
        lastTrainerMode !== "erg" ||
        lastErgTargetSent !== target ||
        tNow - lastErgSendTs >= TRAINER_SEND_MIN_INTERVAL_SEC;

      if (needsSend) {
        log(
          `TrainerState: ERG, target=${target}, force=${force}, lastTarget=${lastErgTargetSent}, lastMode=${lastTrainerMode}`
        );
        await sendErgSetpointRaw(target);
        lastTrainerMode = "erg";
        lastErgTargetSent = target;
        lastErgSendTs = tNow;
      }
    } else if (state.kind === "resistance") {
      const target = Math.round(state.value);
      const needsSend =
        force ||
        lastTrainerMode !== "resistance" ||
        lastResistanceSent !== target ||
        tNow - lastResistanceSendTs >= TRAINER_SEND_MIN_INTERVAL_SEC;

      if (needsSend) {
        log(
          `TrainerState: RESISTANCE, level=${target}, force=${force}, lastLevel=${lastResistanceSent}, lastMode=${lastTrainerMode}`
        );
        await sendResistanceLevelRaw(target);
        lastTrainerMode = "resistance";
        lastResistanceSent = target;
        lastResistanceSendTs = tNow;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Connection flows
  // ---------------------------------------------------------------------------

  async function requestBikeDevice() {
    const options = {
      filters: [{services: [FTMS_SERVICE_UUID]}],
      optionalServices: [FTMS_SERVICE_UUID],
    };
    log(
      "navigator.bluetooth.requestDevice for bike with options: " +
      JSON.stringify(options)
    );
    const device = await navigator.bluetooth.requestDevice(options);
    log("requestDevice returned bike: " + (device.name || "unnamed"));
    return device;
  }

  async function requestHrDevice() {
    const options = {
      filters: [{services: [HEART_RATE_SERVICE_UUID]}],
      optionalServices: [HEART_RATE_SERVICE_UUID, BATTERY_SERVICE_UUID],
    };
    log(
      "navigator.bluetooth.requestDevice for HRM with options: " +
      JSON.stringify(options)
    );
    const device = await navigator.bluetooth.requestDevice(options);
    log("requestDevice returned HRM: " + (device.name || "unnamed"));
    return device;
  }

  async function connectToBike(device) {
    if (!device) throw new Error("connectToBike called without a device");

    if (bikeState.device && bikeState._disconnectHandler) {
      try {
        bikeState.device.removeEventListener(
          "gattserverdisconnected",
          bikeState._disconnectHandler
        );
      } catch {}
    }

    bikeState.device = device;

    if (!bikeState._disconnectHandler) {
      bikeState._disconnectHandler = () => {
        log("BLE disconnected (bike).");
        bikeConnected = false;
        updateBikeStatus("error");

        lastBikeSample = {
          power: null,
          cadence: null,
          speedKph: null,
          hrFromBike: null,
        };
        emit("bikeSample", {...lastBikeSample});
        enqueueReconnect("bike");
      };
    }

    bikeState.device.addEventListener(
      "gattserverdisconnected",
      bikeState._disconnectHandler
    );

    updateBikeStatus("connecting");

    try {
      log("Connecting to GATT server for bike…");
      bikeState.server = await btRetry(() => bikeState.device.gatt.connect());
      log("Connected to GATT server (bike).");

      saveBikeDeviceId(bikeState.device.id);

      bikeState.ftmsService = await btRetry(() =>
        bikeState.server.getPrimaryService(FTMS_SERVICE_UUID)
      );
      log("FTMS service found.");

      bikeState.indoorBikeDataChar = await btRetry(() =>
        bikeState.ftmsService.getCharacteristic(INDOOR_BIKE_DATA_CHAR)
      );
      log("Indoor Bike Data characteristic found.");

      bikeState.controlPointChar = await btRetry(() =>
        bikeState.ftmsService.getCharacteristic(FTMS_CONTROL_POINT_CHAR)
      ).catch((err) => {
        log(
          "Error getting FTMS Control Point characteristic (non-fatal): " + err
        );
        return null;
      });

      if (bikeState.controlPointChar) {
        bikeState.controlPointChar.addEventListener(
          "characteristicvaluechanged",
          (ev) => {
            const dv = ev.target.value;
            if (!dv || dv.byteLength < 3) return;
            const op = dv.getUint8(0);
            const reqOp = dv.getUint8(1);
            const resCode = dv.getUint8(2);
            log(
              `FTMS CP <- Indication: op=0x${op
                .toString(16)
                .padStart(2, "0")}, req=0x${reqOp
                  .toString(16)
                  .padStart(2, "0")}, result=0x${resCode
                    .toString(16)
                    .padStart(2, "0")}`
            );
          }
        );

        // Fatal: if this fails, let connectToBike throw
        await btRetry(() => bikeState.controlPointChar.startNotifications());
        log("Subscribed to FTMS Control Point indications.");
      }

      bikeState.indoorBikeDataChar.addEventListener(
        "characteristicvaluechanged",
        (ev) => {
          const dv = ev.target.value;
          parseIndoorBikeData(dv);
        }
      );

      // Fatal: no Indoor Bike Data = no workout
      await btRetry(() => bikeState.indoorBikeDataChar.startNotifications());
      log("Subscribed to FTMS Indoor Bike Data (0x2AD2).");

      if (bikeState.controlPointChar) {
        // Fatal: if we can't claim control, treat the connection as failed
        await sendFtmsControlPoint(FTMS_OPCODES.requestControl, null);
        await sendFtmsControlPoint(FTMS_OPCODES.startOrResume, null);
        log("FTMS requestControl + startOrResume sent.");
      }

      bikeConnected = true;
      updateBikeStatus("connected");
    } catch (err) {
      log("Bike connect error (fatal): " + err);
      bikeConnected = false;
      updateBikeStatus("error");
      throw err;
    }
  }

  async function connectToHr(device) {
    if (!device) throw new Error("connectToHr called without a device");

    if (hrState.device && hrState._disconnectHandler) {
      try {
        hrState.device.removeEventListener(
          "gattserverdisconnected",
          hrState._disconnectHandler
        );
      } catch {}
    }

    hrState.device = device;

    if (!hrState._disconnectHandler) {
      hrState._disconnectHandler = () => {
        log("BLE disconnected (hr).");
        hrConnected = false;
        updateHrStatus("error");
        hrBatteryPercent = null;
        emit("hrBattery", hrBatteryPercent);
        emit("hrSample", null);
        enqueueReconnect("hr");
      };
    }

    hrState.device.addEventListener(
      "gattserverdisconnected",
      hrState._disconnectHandler
    );

    updateHrStatus("connecting");

    try {
      log("Connecting to GATT server for hr…");
      hrState.server = await btRetry(() => hrState.device.gatt.connect());
      log("Connected to GATT server (hr).");

      saveHrDeviceId(hrState.device.id);

      hrState.hrService = await btRetry(() =>
        hrState.server.getPrimaryService(HEART_RATE_SERVICE_UUID)
      );
      log("Heart Rate service found.");

      hrState.batteryService = await hrState.server
        .getPrimaryService(BATTERY_SERVICE_UUID)
        .catch(() => null);

      hrState.measurementChar = await btRetry(() =>
        hrState.hrService.getCharacteristic(HR_MEASUREMENT_CHAR)
      );
      log("HR Measurement characteristic found.");

      await btRetry(() => hrState.measurementChar.startNotifications());
      hrState.measurementChar.addEventListener(
        "characteristicvaluechanged",
        (ev) => parseHrMeasurement(ev.target.value)
      );
      hrConnected = true;
      updateHrStatus("connected");
      log("Subscribed to HRM Measurement (0x2A37).");

      if (hrState.batteryService) {
        try {
          const batteryLevelChar = await btRetry(() =>
            hrState.batteryService.getCharacteristic(BATTERY_LEVEL_CHAR)
          );
          const val = await btRetry(() => batteryLevelChar.readValue());
          const pct = val.getUint8(0);
          log(`HR battery: ${pct}%`);
          hrBatteryPercent = pct;
          emit("hrBattery", pct);
        } catch (err) {
          log("Battery read failed (non-fatal): " + err);
        }
      }
    } catch (err) {
      log("HR connect error (fatal): " + err);
      hrConnected = false;
      updateHrStatus("error");
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Auto reconnect via navigator.bluetooth.getDevices()
  // ---------------------------------------------------------------------------

  async function maybeReconnectSavedDevicesOnLoad() {
    if (!navigator.bluetooth || !navigator.bluetooth.getDevices) {
      log("Web Bluetooth getDevices() not supported, skipping auto-reconnect.");
      return;
    }

    const {bikeId, hrId} = await loadSavedBleDeviceIds();
    if (!bikeId && !hrId) {
      log("No saved BLE device IDs, skipping auto-reconnect.");
      return;
    }

    let devices;
    try {
      devices = await navigator.bluetooth.getDevices();
    } catch (err) {
      log("getDevices() failed: " + err);
      return;
    }

    log(`getDevices() returned ${devices.length} devices.`);

    const bikeDevice = bikeId ? devices.find((d) => d.id === bikeId) : null;
    const hrDevice = hrId ? devices.find((d) => d.id === hrId) : null;

    if (bikeDevice) {
      log("Found previously paired bike, queueing auto-reconnect…");
      bikeState.device = bikeDevice;
      enqueueReconnect("bike");
    } else if (bikeId) {
      log("Saved bike ID not available in getDevices() (permission revoked?).");
    }

    if (hrDevice) {
      log("Found previously paired HRM, queueing auto-reconnect…");
      hrState.device = hrDevice;
      enqueueReconnect("hr");
    } else if (hrId) {
      log("Saved HRM ID not available in getDevices() (permission revoked?).");
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    init({autoReconnect = true} = {}) {
      if (autoReconnect) {
        maybeReconnectSavedDevicesOnLoad().catch((err) =>
          log("Auto-reconnect error: " + err)
        );
      }
    },

    async connectBikeViaPicker() {
      clearReconnectQueue();
      if (!navigator.bluetooth) {
        throw new Error("Bluetooth not available in this browser.");
      }
      const device = await requestBikeDevice();
      await connectToBike(device);
    },

    async connectHrViaPicker() {
      clearReconnectQueue();
      if (!navigator.bluetooth) {
        throw new Error("Bluetooth not available in this browser.");
      }
      const device = await requestHrDevice();
      await connectToHr(device);
    },

    async setTrainerState(state, opts) {
      // state: { kind: "erg" | "resistance", value: number }
      await setTrainerStateInternal(state, opts);
    },

    getLastBikeSample() {
      return {...lastBikeSample};
    },

    getHrBatteryPercent() {
      return hrBatteryPercent;
    },

    on(type, fn) {
      if (!listeners[type]) throw new Error("Unknown event type: " + type);
      listeners[type].add(fn);
      return () => listeners[type].delete(fn);
    },

    off(type, fn) {
      if (listeners[type]) listeners[type].delete(fn);
    },
  };
})();


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

  // Compute current segment end watts and next segment start watts
  const currEnd =
    segment.targetWattsEnd != null
      ? segment.targetWattsEnd
      : segment.pEndRel * ftp;

  const nextStart =
    next.targetWattsStart != null
      ? next.targetWattsStart
      : next.pStartRel * ftp;

  if (!currEnd || currEnd <= 0) return;

  const diffFrac = Math.abs(nextStart - currEnd) / currEnd; // fractional change

  // If the change is less than 10%, do nothing at all
  if (diffFrac < 0.10) return;

  const secsToEnd = segment.endTimeSec - currentT;
  const secsToEndInt = Math.round(secsToEnd);

  // Next segment target as a % of FTP (1.2 = 120%)
  const nextTargetPct =
    next.targetWattsStart != null
      ? next.targetWattsStart / ftp
      : next.pStartRel;

  // 1) 9 seconds before a segment change of >= 30% AND next >= 120% FTP → air raid siren
  if (diffFrac >= 0.30 && nextTargetPct >= 1.2 && secsToEndInt === 9) {
    Beeper.playDangerDanger();
  }

  // 2) 3 seconds before a segment change of >= 10% → beep pattern
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
      intervalElapsedSec = segment
        ? segment.endTimeSec - elapsedSec
        : 0;

      const currentTarget = target;

      if (mode === "workout") {
        const inGrace = elapsedSec < autoPauseDisabledUntilSec;

        if (!lastSamplePower || lastSamplePower <= 0) {
          if (!inGrace) {
            zeroPowerSeconds++;
          } else {
            zeroPowerSeconds = 0;
          }
          if (!workoutPaused && !inGrace && zeroPowerSeconds >= AUTO_PAUSE_POWER_ZERO_SEC) {
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
      lastSampleTimeSec = t;

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

    // NEW: show pre-select message before user sees the system picker
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
      // NEW: re-show the message if we need to re-prompt for a directory
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
  try {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
  } catch {
    return;
  }

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
    lastSamplePower,
    lastSampleHr,
    lastSampleCadence,
    zeroPowerSeconds,
    autoPauseDisabledUntilSec,
    workoutStartedAt: workoutStartedAt
      ? workoutStartedAt.toISOString()
      : null,
  };

  chrome.storage.local.set({[STORAGE_ACTIVE_STATE]: state});
}

function clearActiveState() {
  try {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
  } catch {
    return;
  }
  chrome.storage.local.remove(STORAGE_ACTIVE_STATE);
}

function loadSelectedWorkout() {
  return new Promise((resolve) => {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) {
        resolve(null);
        return;
      }
    } catch {
      resolve(null);
      return;
    }
    chrome.storage.local.get(
      {[STORAGE_SELECTED_WORKOUT]: null},
      (data) => {
        resolve(data[STORAGE_SELECTED_WORKOUT]);
      }
    );
  });
}

function loadActiveState() {
  return new Promise((resolve) => {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) {
        resolve(null);
        return;
      }
    } catch {
      resolve(null);
      return;
    }
    chrome.storage.local.get(
      {[STORAGE_ACTIVE_STATE]: null},
      (data) => {
        resolve(data[STORAGE_ACTIVE_STATE]);
      }
    );
  });
}
// --------------------------- Workout picker (ZWO selector popup) ---------------------------

// State for the popup
let zwoDirHandle = null;
let pickerWorkouts = [];
let pickerExpandedKey = null;
let pickerSortKey = "kjAdj"; // "if", "tss", "kjAdj", "duration", "name"
let pickerSortDir = "asc";   // "asc" | "desc"
let isPickerOpen = false;

function loadPickerState() {
  return new Promise((resolve) => {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) {
        resolve(null);
        return;
      }
    } catch {
      resolve(null);
      return;
    }

    chrome.storage.local.get(
      {[STORAGE_PICKER_STATE]: null},
      (data) => {
        resolve(data[STORAGE_PICKER_STATE]);
      }
    );
  });
}

function persistPickerState() {
  try {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
  } catch {
    return;
  }

  const state = {
    searchTerm: pickerSearchInput ? pickerSearchInput.value : "",
    category: pickerCategoryFilter ? pickerCategoryFilter.value : "",
    duration: pickerDurationFilter ? pickerDurationFilter.value : "",
    sortKey: pickerSortKey,
    sortDir: pickerSortDir,
  };

  chrome.storage.local.set({[STORAGE_PICKER_STATE]: state});
}

// metrics / parsing (copied from options.js, adapted)

function computeMetricsFromSegments(segments, ftp) {
  const ftpVal = Number(ftp);
  if (
    !Array.isArray(segments) ||
    segments.length === 0 ||
    !Number.isFinite(ftpVal) ||
    ftpVal <= 0
  ) {
    return {
      totalSec: 0,
      durationMin: 0,
      ifValue: null,
      tss: null,
      kj: null,
      ftp: ftpVal > 0 ? ftpVal : null,
    };
  }

  let totalSec = 0;
  let sumFrac = 0;
  let sumFrac4 = 0;

  for (const seg of segments) {
    const dur = Math.max(1, Math.round(Number(seg.durationSec) || 0));
    const p0 = Number(seg.pStartRel) || 0;
    const p1 = Number(seg.pEndRel) || 0;
    const dp = p1 - p0;

    for (let i = 0; i < dur; i++) {
      const tMid = (i + 0.5) / dur;
      const frac = p0 + dp * tMid;
      sumFrac += frac;
      const f2 = frac * frac;
      sumFrac4 += f2 * f2;
      totalSec++;
    }
  }

  if (totalSec === 0) {
    return {
      totalSec: 0,
      durationMin: 0,
      ifValue: null,
      tss: null,
      kj: null,
      ftp: ftpVal,
    };
  }

  const npRel = Math.pow(sumFrac4 / totalSec, 0.25);
  const IF = npRel;
  const durationMin = totalSec / 60;
  const tss = (totalSec * IF * IF) / 36;
  const kJ = (ftpVal * sumFrac) / 1000;

  return {
    totalSec,
    durationMin,
    ifValue: IF,
    tss,
    kj: kJ,
    ftp: ftpVal,
  };
}

function inferCategoryFromSegments(rawSegments) {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return "Uncategorized";
  }

  const zoneTime = {
    recovery: 0,
    base: 0,
    tempo: 0,
    threshold: 0,
    vo2: 0,
    anaerobic: 0,
  };

  let totalSec = 0;
  let workSec = 0;

  for (const seg of rawSegments) {
    if (!Array.isArray(seg) || seg.length < 2) continue;
    const minutes = Number(seg[0]);
    const startPct = Number(seg[1]);
    const endPct = seg.length > 2 && seg[2] != null ? Number(seg[2]) : startPct;

    if (
      !Number.isFinite(minutes) ||
      !Number.isFinite(startPct) ||
      !Number.isFinite(endPct)
    ) {
      continue;
    }

    const durSec = minutes * 60;
    if (durSec <= 0) continue;

    const avgPct = (startPct + endPct) / 2;
    totalSec += durSec;

    let zoneKey;
    if (avgPct < 60) zoneKey = "recovery";
    else if (avgPct < 76) zoneKey = "base";
    else if (avgPct < 90) zoneKey = "tempo";
    else if (avgPct < 105) zoneKey = "threshold";
    else if (avgPct < 119) zoneKey = "vo2";
    else zoneKey = "anaerobic";

    zoneTime[zoneKey] += durSec;

    if (avgPct >= 75) workSec += durSec;
  }

  if (totalSec === 0) return "Uncategorized";

  const z = zoneTime;
  const hiSec = z.vo2 + z.anaerobic;
  const thrSec = z.threshold;
  const tempoSec = z.tempo;

  const workFrac = workSec / totalSec;

  if (workFrac < 0.15) {
    if (z.recovery / totalSec >= 0.7) return "Recovery";
    return "Base";
  }

  const safeDiv = workSec || 1;
  const fracWork = {
    hi: hiSec / safeDiv,
    thr: thrSec / safeDiv,
    tempo: tempoSec / safeDiv,
  };

  if (fracWork.hi >= 0.20) {
    const anaerFrac = z.anaerobic / safeDiv;
    if (anaerFrac >= 0.10) {
      return "HIIT";
    }
    return "VO2Max";
  }

  if (fracWork.thr + fracWork.hi >= 0.35) {
    return "Threshold";
  }

  if (fracWork.tempo + fracWork.thr + fracWork.hi >= 0.5) {
    return "Tempo";
  }

  return "Base";
}

function extractSegmentsFromZwo(doc) {
  const workoutEl = doc.querySelector("workout_file > workout");
  if (!workoutEl) return {segmentsForMetrics: [], segmentsForCategory: []};

  const segments = [];
  const rawSegments = [];

  const children = Array.from(workoutEl.children);

  function pushSeg(durationSec, pLow, pHigh) {
    segments.push({
      durationSec,
      pStartRel: pLow,
      pEndRel: pHigh,
    });
    const minutes = durationSec / 60;
    rawSegments.push([minutes, pLow * 100, pHigh * 100]);
  }

  for (const el of children) {
    const tag = el.tagName;
    if (!tag) continue;
    const name = tag.toLowerCase();

    if (name === "steadystate") {
      const dur = Number(el.getAttribute("Duration") || el.getAttribute("duration") || 0);
      const p = Number(el.getAttribute("Power") || el.getAttribute("power") || 0);
      if (dur > 0 && Number.isFinite(p)) {
        pushSeg(dur, p, p);
      }
    } else if (name === "warmup" || name === "cooldown") {
      const dur = Number(el.getAttribute("Duration") || el.getAttribute("duration") || 0);
      const pLow = Number(el.getAttribute("PowerLow") || el.getAttribute("powerlow") || 0);
      const pHigh = Number(el.getAttribute("PowerHigh") || el.getAttribute("powerhigh") || 0);
      if (dur > 0 && Number.isFinite(pLow) && Number.isFinite(pHigh)) {
        pushSeg(dur, pLow, pHigh);
      }
    } else if (name === "intervalst") {
      const repeat = Number(el.getAttribute("Repeat") || el.getAttribute("repeat") || 1);
      const onDur = Number(el.getAttribute("OnDuration") || el.getAttribute("onduration") || 0);
      const offDur = Number(el.getAttribute("OffDuration") || el.getAttribute("offduration") || 0);
      const onP = Number(el.getAttribute("OnPower") || el.getAttribute("onpower") || 0);
      const offP = Number(el.getAttribute("OffPower") || el.getAttribute("offpower") || 0);

      const reps = Number.isFinite(repeat) && repeat > 0 ? repeat : 1;
      for (let i = 0; i < reps; i++) {
        if (onDur > 0 && Number.isFinite(onP)) {
          pushSeg(onDur, onP, onP);
        }
        if (offDur > 0 && Number.isFinite(offP)) {
          pushSeg(offDur, offP, offP);
        }
      }
    }
  }

  return {
    segmentsForMetrics: segments,
    segmentsForCategory: rawSegments,
  };
}

function parseZwo(xmlText, fileName) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  const nameEl = doc.querySelector("workout_file > name");
  const descEl = doc.querySelector("workout_file > description");
  const tagEls = Array.from(doc.querySelectorAll("workout_file > tags > tag"));

  const name = (nameEl && nameEl.textContent.trim()) || fileName;
  const description = descEl ? descEl.textContent || "" : "";

  const tags = tagEls
    .map((t) => t.getAttribute("name") || "")
    .filter(Boolean);

  let source = null;
  let ftpFromTag = null;

  for (const tag of tags) {
    const trimmed = tag.trim();
    if (/^TrainerRoad$/i.test(trimmed)) source = "TrainerRoad";
    else if (/^TrainerDay$/i.test(trimmed)) source = "TrainerDay";
    else if (/^WhatsOnZwift$/i.test(trimmed)) source = "WhatsOnZwift";

    const ftpMatch = trimmed.match(/^FTP:(\d+)/i);
    if (ftpMatch) {
      ftpFromTag = Number(ftpMatch[1]);
    }
  }

  const {segmentsForMetrics, segmentsForCategory} = extractSegmentsFromZwo(doc);

  const ftpUsed = Number.isFinite(ftpFromTag) && ftpFromTag > 0 ? ftpFromTag : DEFAULT_FTP;
  const metrics = computeMetricsFromSegments(segmentsForMetrics, ftpUsed);

  const category = inferCategoryFromSegments(segmentsForCategory);

  return {
    fileName,
    name,
    description,
    tags,
    source: source || "Unknown",
    ftpFromFile: ftpUsed,
    baseKj: metrics.kj != null ? metrics.kj : null,
    ifValue: metrics.ifValue != null ? metrics.ifValue : null,
    tss: metrics.tss != null ? metrics.tss : null,
    durationMin: metrics.durationMin != null ? metrics.durationMin : null,
    totalSec: metrics.totalSec != null ? metrics.totalSec : null,
    category,
    segmentsForMetrics,
    segmentsForCategory,
  };
}

async function scanWorkoutsFromDirectory(handle) {
  const workouts = [];
  try {
    for await (const entry of handle.values()) {
      if (entry.kind !== "file") continue;
      if (!entry.name.toLowerCase().endsWith(".zwo")) continue;

      const file = await entry.getFile();
      const text = await file.text();
      const meta = parseZwo(text, entry.name);
      workouts.push(meta);
    }
  } catch (err) {
    console.error("[Workout] Error scanning workouts:", err);
  }
  return workouts;
}

// adjusted kJ using current FTP
function getAdjustedKjForPicker(workout) {
  if (workout.baseKj == null || !Number.isFinite(workout.ftpFromFile) || !Number.isFinite(currentFtp)) {
    return workout.baseKj;
  }
  if (workout.ftpFromFile <= 0) return workout.baseKj;
  return workout.baseKj * (currentFtp / workout.ftpFromFile);
}

function getDurationBucket(durationMin) {
  if (!Number.isFinite(durationMin)) return ">240";
  if (durationMin <= 30) return "0-30";
  if (durationMin <= 60) return "30-60";
  if (durationMin <= 90) return "60-90";
  if (durationMin <= 120) return "90-120";
  if (durationMin <= 150) return "120-150";
  if (durationMin <= 180) return "150-180";
  if (durationMin <= 210) return "180-210";
  if (durationMin <= 240) return "210-240";
  return ">240";
}

function computeVisiblePickerWorkouts() {
  const searchTerm = (pickerSearchInput && pickerSearchInput.value || "").toLowerCase();
  const catValue = (pickerCategoryFilter && pickerCategoryFilter.value) || "";
  const durValue = (pickerDurationFilter && pickerDurationFilter.value) || "";

  let shown = pickerWorkouts;

  if (catValue) {
    shown = shown.filter((w) => w.category === catValue);
  }

  if (durValue) {
    shown = shown.filter((w) => getDurationBucket(w.durationMin) === durValue);
  }

  if (searchTerm) {
    shown = shown.filter((w) => {
      const haystack = [
        w.name,
        w.category,
        w.source,
        (w.description || "").slice(0, 300),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(searchTerm);
    });
  }

  const sortKey = pickerSortKey;
  const dir = pickerSortDir === "asc" ? 1 : -1;

  shown = shown.slice().sort((a, b) => {
    function num(val) {
      return Number.isFinite(val) ? val : -Infinity;
    }
    if (sortKey === "kjAdj") {
      return (num(getAdjustedKjForPicker(a)) - num(getAdjustedKjForPicker(b))) * dir;
    }
    if (sortKey === "if") {
      return (num(a.ifValue) - num(b.ifValue)) * dir;
    }
    if (sortKey === "tss") {
      return (num(a.tss) - num(b.tss)) * dir;
    }
    if (sortKey === "duration") {
      return (num(a.durationMin) - num(b.durationMin)) * dir;
    }
    if (sortKey === "name") {
      return a.name.localeCompare(b.name) * dir;
    }
    return 0;
  });

  return shown;
}

function refreshPickerCategoryFilter() {
  if (!pickerCategoryFilter) return;

  const valueBefore = pickerCategoryFilter.value;
  const cats = Array.from(
    new Set(pickerWorkouts.map((w) => w.category || "Uncategorized"))
  ).sort((a, b) => a.localeCompare(b));

  pickerCategoryFilter.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "All categories";
  pickerCategoryFilter.appendChild(optAll);

  for (const c of cats) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    pickerCategoryFilter.appendChild(opt);
  }

  if (cats.includes(valueBefore)) {
    pickerCategoryFilter.value = valueBefore;
  }
}

function updatePickerSortHeaderIndicator() {
  const headers = pickerModal
    ? pickerModal.querySelectorAll("th[data-sort-key]")
    : [];
  headers.forEach((th) => {
    const key = th.getAttribute("data-sort-key");
    th.classList.remove("sorted-asc", "sorted-desc");
    if (key === pickerSortKey) {
      th.classList.add(pickerSortDir === "asc" ? "sorted-asc" : "sorted-desc");
    }
  });
}

function renderMiniWorkoutGraph(container, workout) {
  container.innerHTML = "";

  const baseSegments = workout.segmentsForMetrics || [];
  if (!baseSegments.length) {
    container.textContent = "No workout structure available.";
    container.classList.add("picker-detail-empty");
    return;
  }

  // Use same FTP logic pattern as buildScaledSegments, but per workout
  const ftp = currentFtp || workout.ftpAtSelection || DEFAULT_FTP;
  const {scaledSegments: localScaledSegments, totalSec} = computeScaledSegments(baseSegments, ftp);

  if (!localScaledSegments.length || totalSec <= 0) {
    container.textContent = "No workout structure available.";
    container.classList.add("picker-detail-empty");
    return;
  }

  const width = 400;
  const height = 120;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("picker-graph-svg");

  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", width);
  bg.setAttribute("height", height);
  bg.setAttribute("fill", "transparent");
  svg.appendChild(bg);

  const maxY = Math.max(200, ftp * 2); // same as drawChart

  // Reuse shared polygon renderer; segments are in the same shape as for drawChart
  localScaledSegments.forEach((seg) => {
    renderWorkoutSegmentPolygon({
      svg,
      seg,
      totalSec,
      width,
      height,
      ftp,
      maxY,
    });
  });

  const tooltip = document.createElement("div");
  tooltip.className = "picker-tooltip";

  container.appendChild(svg);
  container.appendChild(tooltip);

  attachSegmentHover(svg, tooltip, container);
}


function renderWorkoutPickerTable() {
  if (!pickerWorkoutTbody) return;

  const total = pickerWorkouts.length;

  if (total === 0) {
    pickerWorkoutTbody.innerHTML = "";
    if (pickerSummaryEl) {
      pickerSummaryEl.textContent = "No .zwo files found in this folder yet.";
    }
    updatePickerSortHeaderIndicator();
    return;
  }

  const shown = computeVisiblePickerWorkouts();
  const shownCount = shown.length;

  pickerWorkoutTbody.innerHTML = "";

  if (pickerSummaryEl) {
    pickerSummaryEl.textContent = `${shownCount} of ${total} workouts shown`;
  }

  const colCount = 7;

  for (const w of shown) {
    const key = w.fileName || w.name;
    const tr = document.createElement("tr");
    tr.className = "picker-row";
    tr.dataset.key = key;

    const tdName = document.createElement("td");
    tdName.textContent = w.name;
    tdName.title = w.fileName;
    tr.appendChild(tdName);

    const tdCat = document.createElement("td");
    tdCat.textContent = w.category || "Uncategorized";
    tr.appendChild(tdCat);

    const tdSource = document.createElement("td");
    tdSource.textContent = w.source || "";
    tr.appendChild(tdSource);

    const tdIf = document.createElement("td");
    tdIf.textContent = w.ifValue != null ? w.ifValue.toFixed(2) : "";
    tr.appendChild(tdIf);

    const tdTss = document.createElement("td");
    tdTss.textContent = w.tss != null ? String(Math.round(w.tss)) : "";
    tr.appendChild(tdTss);

    const tdDur = document.createElement("td");
    tdDur.textContent =
      w.durationMin != null ? `${Math.round(w.durationMin)} min` : "";
    tr.appendChild(tdDur);

    const adjKj = getAdjustedKjForPicker(w);
    const tdKj = document.createElement("td");
    tdKj.textContent = adjKj != null ? `${Math.round(adjKj)} kJ` : "";
    tr.appendChild(tdKj);

    pickerWorkoutTbody.appendChild(tr);

    const expanded = pickerExpandedKey === key;
    if (expanded) {
      const expTr = document.createElement("tr");
      expTr.className = "picker-expanded-row";
      const expTd = document.createElement("td");
      expTd.colSpan = colCount;

      const container = document.createElement("div");
      container.className = "picker-expanded";

      const graphDiv = document.createElement("div");
      graphDiv.className = "picker-graph";

      const detailDiv = document.createElement("div");
      detailDiv.className = "picker-detail";

      const headerRow = document.createElement("div");
      headerRow.style.display = "flex";
      headerRow.style.justifyContent = "flex-end";
      headerRow.style.marginBottom = "4px";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "select-workout-btn";
      selectBtn.textContent = "Select workout";
      selectBtn.title = "Use this workout on the workout page.";
      selectBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        selectWorkoutFromPicker(w);
      });

      headerRow.appendChild(selectBtn);
      detailDiv.appendChild(headerRow);

      if (w.description && w.description.trim()) {
        const descHtml = w.description.replace(/\n/g, "<br>");
        const descContainer = document.createElement("div");
        descContainer.innerHTML = descHtml;
        detailDiv.appendChild(descContainer);
      } else {
        const empty = document.createElement("div");
        empty.className = "picker-detail-empty";
        empty.textContent = "(No description)";
        detailDiv.appendChild(empty);
      }

      container.appendChild(graphDiv);
      container.appendChild(detailDiv);
      expTd.appendChild(container);
      expTr.appendChild(expTd);
      pickerWorkoutTbody.appendChild(expTr);

      renderMiniWorkoutGraph(graphDiv, w);
    }

    tr.addEventListener("click", () => {
      if (pickerExpandedKey === key) {
        pickerExpandedKey = null;
      } else {
        pickerExpandedKey = key;
      }
      renderWorkoutPickerTable();
    });
  }

  updatePickerSortHeaderIndicator();
}

function movePickerExpansion(delta) {
  const shown = computeVisiblePickerWorkouts();
  if (!shown.length) return;

  let idx = shown.findIndex((w) => {
    const key = w.fileName || w.name;
    return key === pickerExpandedKey;
  });

  if (idx === -1) {
    idx = delta > 0 ? 0 : shown.length - 1;
  } else {
    idx = (idx + delta + shown.length) % shown.length;
  }

  const next = shown[idx];
  pickerExpandedKey = next.fileName || next.name;
  renderWorkoutPickerTable();
}

function setupPickerSorting() {
  if (!pickerModal) return;
  const headerCells = pickerModal.querySelectorAll("th[data-sort-key]");
  headerCells.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort-key");
      if (!key) return;
      if (pickerSortKey === key) {
        pickerSortDir = pickerSortDir === "asc" ? "desc" : "asc";
      } else {
        pickerSortKey = key;
        pickerSortDir = key === "kjAdj" ? "asc" : "desc";
      }
      renderWorkoutPickerTable();
      persistPickerState();
    });
  });
  updatePickerSortHeaderIndicator();
}

function setupPickerHotkeys() {
  document.addEventListener("keydown", (e) => {
    if (!isPickerOpen) return;

    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

    const key = e.key;

    // navigation
    if (key === "ArrowDown" || key === "j" || key === "J") {
      e.preventDefault();
      return movePickerExpansion(+1);
    }

    if (key === "ArrowUp" || key === "k" || key === "K") {
      e.preventDefault();
      return movePickerExpansion(-1);
    }
  });
}

async function ensureZwoDirectoryHandle() {
  if (!("showDirectoryPicker" in window)) {
    alert("Selecting ZWO workouts requires a recent Chromium-based browser.");
    return null;
  }

  if (!zwoDirHandle) {
    try {
      const stored = await loadZwoDirHandle();
      if (stored) {
        const ok = await ensureDirPermission(stored);
        if (ok) {
          zwoDirHandle = stored;
          return zwoDirHandle;
        }
      }
    } catch (err) {
      logDebug("Failed to load ZWO dir handle: " + err);
    }
  }

  if (!zwoDirHandle) {
    try {
      // NEW: show pre-select message before user sees the system picker
      showZwoDirectoryPreselectMessage();

      const handle = await window.showDirectoryPicker();
      const ok = await ensureDirPermission(handle);
      if (!ok) {
        alert("Permission was not granted to the selected ZWO folder.");
        return null;
      }
      zwoDirHandle = handle;
      await saveZwoDirHandle(handle);
    } catch (err) {
      if (err && err.name === "AbortError") {
        // user canceled
        return null;
      }
      logDebug("Error choosing ZWO folder: " + err);
      alert("Failed to choose ZWO folder.");
      return null;
    }
  }

  return zwoDirHandle;
}

async function rescanPickerWorkouts() {
  if (!zwoDirHandle) {
    pickerWorkouts = [];
    renderWorkoutPickerTable();
    return;
  }

  const ok = await ensureDirPermission(zwoDirHandle);
  if (!ok) {
    pickerWorkouts = [];
    zwoDirHandle = null;
    renderWorkoutPickerTable();
    return;
  }

  pickerExpandedKey = null;
  pickerWorkouts = await scanWorkoutsFromDirectory(zwoDirHandle);
  refreshPickerCategoryFilter();

  const saved = await loadPickerState();
  if (saved) {
    if (pickerSearchInput) {
      pickerSearchInput.value = saved.searchTerm || "";
    }
    if (pickerCategoryFilter) {
      pickerCategoryFilter.value = saved.category || "";
    }
    if (pickerDurationFilter) {
      pickerDurationFilter.value = saved.duration || "";
    }

    if (saved.sortKey) {
      pickerSortKey = saved.sortKey;
    }
    if (saved.sortDir === "asc" || saved.sortDir === "desc") {
      pickerSortDir = saved.sortDir;
    }
  }

  renderWorkoutPickerTable();
}

function selectWorkoutFromPicker(workoutMetaFull) {
  // Payload format matches options.js -> workout.html expectations
  const payload = {
    name: workoutMetaFull.name,
    fileName: workoutMetaFull.fileName,
    totalSec: workoutMetaFull.totalSec,
    segmentsForMetrics: workoutMetaFull.segmentsForMetrics || [],
    ftpAtSelection: currentFtp,
  };

  try {
    if (!chrome || !chrome.storage || !chrome.storage.local) {
      alert("Selecting workouts requires the extension environment.");
      return;
    }
  } catch {
    alert("Selecting workouts requires the extension environment.");
    return;
  }

  chrome.storage.local.set({[STORAGE_SELECTED_WORKOUT]: payload}, () => {
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

    closeWorkoutPicker();
  });
}

async function openWorkoutPicker() {
  if (workoutRunning) {
    alert("End the current workout before changing the workout selection.");
    return;
  }

  const handle = await ensureZwoDirectoryHandle();
  if (!handle) {
    if (pickerSummaryEl) {
      pickerSummaryEl.textContent = "No ZWO folder selected.";
    }
  } else {
    await rescanPickerWorkouts();
  }

  isPickerOpen = true;
  if (pickerOverlay) {
    pickerOverlay.style.display = "flex";
  }

  if (pickerSearchInput) {
    pickerSearchInput.focus();
  }
}

function closeWorkoutPicker() {
  isPickerOpen = false;
  if (pickerOverlay) {
    pickerOverlay.style.display = "none";
  }
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

  try {
    if (chrome && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ftp: currentFtp});
    }
  } catch {}

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
    // no active workout
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
      workoutStartEpochMs = Date.now();
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

  if (window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (_) => {
      rerenderThemeSensitive();
      if (isPickerOpen) {
        renderWorkoutPickerTable();
      }
    };
    if (mql.addEventListener) mql.addEventListener("change", handler);
  }

  loadSoundPreference();

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
    lastSamplePower = activeState.lastSamplePower ?? lastSamplePower;
    lastSampleHr = activeState.lastSampleHr ?? lastSampleHr;
    lastSampleCadence = activeState.lastSampleCadence ?? lastSampleCadence;
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

  // Workout name: always clickable to open picker
  if (workoutNameLabel) {
    workoutNameLabel.dataset.clickable = "true";
    workoutNameLabel.title = "Click to choose a workout.";
    workoutNameLabel.addEventListener("click", () => {
      openWorkoutPicker().catch((err) => {
        logDebug("Workout picker open error: " + err);
      });
    });
  }

  // Picker events
  if (pickerCloseBtn) {
    pickerCloseBtn.addEventListener("click", () => {
      closeWorkoutPicker();
    });
  }

  if (pickerOverlay) {
    pickerOverlay.addEventListener("click", (e) => {
      if (e.target === pickerOverlay) {
        closeWorkoutPicker();
      }
    });
  }

  if (pickerSearchInput) {
    pickerSearchInput.addEventListener("input", () => {
      renderWorkoutPickerTable();
      persistPickerState();
    });
  }

  if (pickerCategoryFilter) {
    pickerCategoryFilter.addEventListener("change", () => {
      renderWorkoutPickerTable();
      persistPickerState();
    });
  }

  if (pickerDurationFilter) {
    pickerDurationFilter.addEventListener("change", () => {
      renderWorkoutPickerTable();
      persistPickerState();
    });
  }


  setupPickerSorting();
  setupPickerHotkeys();


  // FTP click handler (CSS handles hover/active)
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
    persistSoundPreference();
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
      if (isPickerOpen) {
        closeWorkoutPicker();
        return;
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

