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

const DB_NAME = "zwo-downloader";
const DB_VERSION = 1;
const WORKOUT_DIR_KEY = "workoutDirHandle";

const STORAGE_SELECTED_WORKOUT = "selectedWorkout";
const STORAGE_ACTIVE_STATE = "activeWorkoutState";
const STORAGE_SOUND_ENABLED = "soundEnabled";
const STORAGE_LAST_DEVICE_ID = "lastKickrDeviceId";

// Auto-pause after 1 second of 0 power (effectively 2 consecutive samples)
const AUTO_PAUSE_POWER_ZERO_SEC = 1;
const AUTO_PAUSE_GRACE_SEC = 15;

const TRAINER_SEND_MIN_INTERVAL_SEC = 10; // don't spam trainer when target unchanged

// --------------------------- DOM refs ---------------------------

const statPowerEl = document.getElementById("stat-power");
const statIntervalTimeEl = document.getElementById("stat-interval-time");
const statHrEl = document.getElementById("stat-hr");
const statTargetPowerEl = document.getElementById("stat-target-power");
const statElapsedTimeEl = document.getElementById("stat-elapsed-time");
const statCadenceEl = document.getElementById("stat-cadence");

const chartSvg = document.getElementById("chartSvg");
const chartPanel = document.querySelector(".chart-panel");
const chartTooltip = document.getElementById("chartTooltip");

const bikeConnectBtn = document.getElementById("bikeConnectBtn");
const bikeStatusDot = document.getElementById("bikeStatusDot");
const hrConnectBtn = document.getElementById("hrConnectBtn");
const hrStatusDot = document.getElementById("hrStatusDot");
const bikeBatteryLabel = document.getElementById("bikeBatteryLabel");
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
const goBackBtn = document.getElementById("goBackBtn");

const debugOverlay = document.getElementById("debugOverlay");
const debugCloseBtn = document.getElementById("debugCloseBtn");
const debugLog = document.getElementById("debugLog");

const statusOverlay = document.getElementById("statusOverlay");
const statusText = document.getElementById("statusText");

// --------------------------- State ---------------------------

// BLE
let bluetoothDevice = null;
let gattServer = null;
let ftmsService = null;
let indoorBikeDataChar = null;
let ftmsControlPointChar = null;
let heartRateService = null;
let hrMeasurementChar = null;
let batteryService = null;

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

// dark-mode cache
let darkModeCached = null;

// --------------------------- Helpers ---------------------------

function logDebug(msg) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${msg}`;
  logLines.push(line);
  // keep only last 5000 lines
  if (logLines.length > 5000) {
    logLines.splice(0, logLines.length - 5000);
  }
  console.log("[Workout]", msg);

  if (debugLog) {
    // Only tail if we're already at the bottom
    const isAtBottom =
      debugLog.scrollTop + debugLog.clientHeight >= debugLog.scrollHeight - 4;
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

function isDarkMode() {
  if (darkModeCached === null) {
    darkModeCached = detectDarkMode();
  }
  return darkModeCached;
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

    const fs = Math.max(
      18,
      Math.min(availableHeight * 0.7, availableWidth / 3.5) * 0.9 // 90%
    );
    valueEl.style.fontSize = `${fs}px`;
  });
}

// --------------------------- Chart dimension helpers ---------------------------

function updateChartDimensions() {
  if (!chartPanel) return;
  const rect = chartPanel.getBoundingClientRect();
  const w = rect.width || window.innerWidth || 800;
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

  let t = 0;
  scaledSegments = segments.map((seg) => {
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

  workoutTotalSec = t;
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
  if (pct < 55) key = "Recovery";
  else if (pct < 76) key = "Base";
  else if (pct < 88) key = "Tempo";
  else if (pct < 95) key = "SweetSpot";
  else if (pct < 106) key = "Threshold";
  else if (pct < 121) key = "VO2Max";
  else key = "Anaerobic";

  const colorVarMap = {
    Recovery: "--zone-recovery",
    Base: "--zone-base",
    Tempo: "--zone-tempo",
    SweetSpot: "--zone-sweetspot",
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

function drawChart() {
  if (!chartSvg) return;
  updateChartDimensions();
  clearSvg(chartSvg);

  const w = chartWidth;
  const h = chartHeight;
  chartSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const ftp = currentFtp || DEFAULT_FTP;
  const maxY = Math.max(200, ftp * 2);

  // grid lines & labels (behind intervals)
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
    label.setAttribute("font-size", "11");
    label.setAttribute("fill", getCssVar("--text-muted"));
    label.setAttribute("pointer-events", "none");
    label.textContent = String(yVal);
    chartSvg.appendChild(label);
  }

  const totalSec = workoutTotalSec || 1;

  // intervals (muted color but full opacity)
  scaledSegments.forEach((seg) => {
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

    const muted = mixColors(zone.color, zone.bg, 0.5);
    const hover = mixColors(muted, zone.color, 0.3);

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

    chartSvg.appendChild(poly);
  });

  // shade past
  if (elapsedSec > 0 && totalSec > 0) {
    const xPast = Math.min(w, (elapsedSec / totalSec) * w);
    const shade = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    shade.setAttribute("x", "0");
    shade.setAttribute("y", "0");
    shade.setAttribute("width", String(xPast));
    shade.setAttribute("height", String(h));
    shade.setAttribute("fill", "#000000");
    shade.setAttribute("fill-opacity", "0.1");
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
  ftpLabel.setAttribute("font-size", "11");
  ftpLabel.setAttribute("fill", getCssVar("--ftp-line"));
  ftpLabel.setAttribute("text-anchor", "end");
  ftpLabel.setAttribute("pointer-events", "none");
  ftpLabel.textContent = `FTP ${ftp}`;
  chartSvg.appendChild(ftpLabel);

  // position line
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

  // foreground lines
  const samples = liveSamples;
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
      const powerColor = isDarkMode() ? "#ffb300" : "#f57c00";
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", powerPath);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", powerColor);
      p.setAttribute("stroke-width", "1.4");
      p.setAttribute("pointer-events", "none");
      chartSvg.appendChild(p);
    }

    const hrPath = pathForKey("hr");
    if (hrPath) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", hrPath);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "#ec407a");
      p.setAttribute("stroke-width", "1.0");
      p.setAttribute("pointer-events", "none");
      chartSvg.appendChild(p);
    }

    const cadPath = pathForKey("cadence");
    if (cadPath) {
      const cadColor = isDarkMode() ? "#26a69a" : "#00897b";
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", cadPath);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", cadColor);
      p.setAttribute("stroke-width", "1.0");
      p.setAttribute("pointer-events", "none");
      chartSvg.appendChild(p);
    }
  }
}

// hover for intervals
function setupChartHover() {
  if (!chartSvg || !chartPanel || !chartTooltip) return;

  chartSvg.addEventListener("mousemove", (e) => {
    const target = e.target;
    if (!(target instanceof SVGElement) || !target.dataset.zone) {
      chartTooltip.style.display = "none";
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

    const zone = target.dataset.zone;
    const p0 = target.dataset.p0;
    const p1 = target.dataset.p1;
    const durMin = target.dataset.durMin;

    chartTooltip.textContent = `${zone}: ${p0}%–${p1}% FTP, ${durMin} min`;
    chartTooltip.style.display = "block";

    const rect = chartPanel.getBoundingClientRect();
    let tx = e.clientX - rect.left + 8;
    let ty = e.clientY - rect.top + 8;

    const ttRect = chartTooltip.getBoundingClientRect();

    if (tx + ttRect.width > rect.width - 4) {
      tx = rect.width - ttRect.width - 4;
    }
    if (tx < 0) tx = 0;

    if (ty + ttRect.height > rect.height - 4) {
      ty = rect.height - ttRect.height - 4;
    }
    if (ty < 0) ty = 0;

    chartTooltip.style.left = `${tx}px`;
    chartTooltip.style.top = `${ty}px`;

    if (lastHoveredSegment && lastHoveredSegment !== target) {
      const prevColor =
        lastHoveredSegment.dataset.mutedColor ||
        lastHoveredSegment.dataset.color;
      if (prevColor) {
        lastHoveredSegment.setAttribute("fill", prevColor);
      }
    }
    const hoverColor =
      target.dataset.hoverColor ||
      target.dataset.color ||
      target.dataset.mutedColor;
    if (hoverColor) {
      target.setAttribute("fill", hoverColor);
    }
    lastHoveredSegment = target;
  });

  chartSvg.addEventListener("mouseleave", () => {
    chartTooltip.style.display = "none";
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
  return zone.color || getCssVar("--stat-number-color");
}

function updateStatsDisplay() {
  // show "--" only if we have no data at all, otherwise show 0 as 0
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
  if (!isDarkMode()) {
    // make 50% darker in light mode
    color = mixColors(color, "#000000", 0.5);
  }

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

async function requestBikeDevice() {
  const options = {
    filters: [{services: [FTMS_SERVICE_UUID]}],
    optionalServices: [
      FTMS_SERVICE_UUID,
      HEART_RATE_SERVICE_UUID,
      BATTERY_SERVICE_UUID,
    ],
  };
  logDebug(
    "navigator.bluetooth.requestDevice for bike with options: " +
    JSON.stringify(options)
  );
  const device = await navigator.bluetooth.requestDevice(options);
  logDebug("requestDevice returned bike: " + (device.name || "unnamed"));
  return device;
}

async function requestHrDevice() {
  const options = {
    filters: [{services: [HEART_RATE_SERVICE_UUID]}],
    optionalServices: [HEART_RATE_SERVICE_UUID, BATTERY_SERVICE_UUID],
  };
  logDebug(
    "navigator.bluetooth.requestDevice for HRM with options: " +
    JSON.stringify(options)
  );
  const device = await navigator.bluetooth.requestDevice(options);
  logDebug("requestDevice returned HRM: " + (device.name || "unnamed"));
  return device;
}

// --------------------------- Trainer command helpers ---------------------------

function nowSec() {
  return performance.now() / 1000;
}

// Generic helper to send FTMS control point commands (with optional SINT16 param)
async function sendFtmsControlPoint(opCode, sint16Param /* or null */) {
  if (!ftmsControlPointChar) {
    logDebug("FTMS CP write attempted, but characteristic not ready.");
    throw new Error("FTMS Control Point characteristic not ready");
  }

  let buffer;
  if (sint16Param == null) {
    buffer = new Uint8Array([opCode]).buffer;
  } else {
    buffer = new ArrayBuffer(3);
    const view = new DataView(buffer);
    view.setUint8(0, opCode);
    view.setInt16(1, sint16Param, true); // little-endian SINT16
  }

  logDebug(
    `FTMS CP -> opCode=0x${opCode.toString(16)}, param=${sint16Param ?? "none"
    }`
  );

  const fn =
    ftmsControlPointChar.writeValueWithResponse ||
    ftmsControlPointChar.writeValue;
  await fn.call(ftmsControlPointChar, buffer);
}

async function sendErgSetpointRaw(targetWatts) {
  if (!ftmsControlPointChar) return;
  const val = Math.max(0, Math.min(2000, targetWatts | 0));
  try {
    await sendFtmsControlPoint(FTMS_OPCODES.setTargetPower, val);
    logDebug(`ERG target → ${val} W`);
  } catch (err) {
    logDebug("Failed to set ERG target: " + err);
  }
}

async function sendResistanceLevelRaw(level) {
  if (!ftmsControlPointChar) return;
  const clamped = Math.max(0, Math.min(100, level | 0));
  const tenth = clamped * 10; // FTMS uses 0.1 increments
  try {
    await sendFtmsControlPoint(
      FTMS_OPCODES.setTargetResistanceLevel,
      tenth
    );
    logDebug(`Resistance level → ${clamped}`);
  } catch (err) {
    logDebug("Failed to set resistance: " + err);
  }
}

function desiredTrainerState() {
  if (!isBikeConnected || !ftmsControlPointChar) return null;

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

  const tNow = nowSec();

  if (st.kind === "erg") {
    const target = Math.round(st.value);
    const needsSend =
      force ||
      lastTrainerMode !== "erg" ||
      lastErgTargetSent !== target ||
      tNow - lastErgSendTs >= TRAINER_SEND_MIN_INTERVAL_SEC;

    if (needsSend) {
      logDebug(
        `TrainerState: ERG, target=${target}, force=${force}, lastTarget=${lastErgTargetSent}, lastMode=${lastTrainerMode}`
      );
      await sendErgSetpointRaw(target);
      lastTrainerMode = "erg";
      lastErgTargetSent = target;
      lastErgSendTs = tNow;
    }
  } else if (st.kind === "resistance") {
    const target = Math.round(st.value);
    const needsSend =
      force ||
      lastTrainerMode !== "resistance" ||
      lastResistanceSent !== target ||
      tNow - lastResistanceSendTs >= TRAINER_SEND_MIN_INTERVAL_SEC;

    if (needsSend) {
      logDebug(
        `TrainerState: RESISTANCE, level=${target}, force=${force}, lastLevel=${lastResistanceSent}, lastMode=${lastTrainerMode}`
      );
      await sendResistanceLevelRaw(target);
      lastTrainerMode = "resistance";
      lastResistanceSent = target;
      lastResistanceSendTs = tNow;
    }
  }
}

// --------------------------- Auto-start helper ---------------------------

function maybeAutoStartFromPower(power) {
  if (!power || power <= 0) return;
  if (mode !== "workout") return;
  if (workoutRunning) return;
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

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function playBeep(durationMs = 150, freq = 880, gain = 0.5) {
  if (!soundEnabled) return;
  ensureAudioContext();
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();
  osc.frequency.value = freq;
  gainNode.gain.value = gain;
  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + durationMs / 1000);
  logDebug(`Audio beep: freq=${freq}Hz, duration=${durationMs}ms, gain=${gain}`);
}

function overlayTextColor() {
  return isDarkMode() ? "#999999" : "#555555";
}

function overlayTextShadow() {
  return isDarkMode()
    ? "0 2px 4px rgba(0,0,0,0.9)"
    : "0 2px 4px rgba(255,255,255,0.9)";
}

function showStatusMessage(text, heightRatio = 0.2, durationMs = 800) {
  if (!statusOverlay || !statusText) return;
  const totalHeight = window.innerHeight || 800;
  const fontSize = Math.floor(totalHeight * heightRatio);
  statusText.textContent = text;
  statusText.style.fontSize = `${fontSize}px`;
  statusText.style.color = overlayTextColor();
  statusText.style.textShadow = overlayTextShadow();
  statusOverlay.style.display = "flex";
  void statusOverlay.offsetWidth;
  statusOverlay.style.opacity = "1";

  setTimeout(() => {
    statusOverlay.style.opacity = "0";
    setTimeout(() => {
      statusOverlay.style.display = "none";
    }, 300);
  }, durationMs);
}

function runStartCountdown(onDone) {
  if (!statusOverlay || !statusText) {
    onDone && onDone();
    return;
  }
  if (countdownRunning) return;
  countdownRunning = true;

  const seq = ["3", "2", "1", "Start"];
  let idx = 0;

  const totalHeight = window.innerHeight || 800;
  const baseColor = overlayTextColor();
  const fontSize = Math.floor(totalHeight * 0.25);
  const shadow = overlayTextShadow();

  const step = () => {
    if (idx >= seq.length) {
      statusOverlay.style.opacity = "0";
      setTimeout(() => {
        statusOverlay.style.display = "none";
        countdownRunning = false;
        onDone && onDone();
      }, 200);
      return;
    }

    const label = seq[idx];
    statusText.textContent = label;
    statusText.style.fontSize = `${fontSize}px`;
    statusText.style.color = baseColor;
    statusText.style.textShadow = shadow;
    statusOverlay.style.display = "flex";

    void statusOverlay.offsetWidth;
    statusOverlay.style.opacity = "1";

    if (label === "Start") {
      playBeep(220, 660, 0.5);
    } else {
      playBeep(120, 880, 0.4);
    }

    setTimeout(() => {
      statusOverlay.style.opacity = "0";
    }, 500);

    idx++;
    setTimeout(step, 1000);
  };

  step();
}

function showPausedOverlay() {
  showStatusMessage("Workout Paused", 0.2, 800);
}

function showResumedOverlay() {
  showStatusMessage("Workout Resumed", 0.2, 800);
}

// --------------------------- BLE parsing (FTMS-only) ---------------------------

// Parse Indoor Bike Data (0x2AD2) like the working test script.
function parseIndoorBikeData(dataView) {
  if (!dataView || dataView.byteLength < 4) return;

  let index = 0;

  // Flags (uint16, little-endian)
  const flags = dataView.getUint16(index, true);
  index += 2;

  // bit0: More Data (0 => Instantaneous Speed present)
  // bit1: Average Speed present
  // bit2: Instantaneous Cadence present
  // bit3: Average Cadence present
  // bit4: Total Distance present
  // bit5: Resistance Level present
  // bit6: Instantaneous Power present
  // bit7: Average Power present
  // bit8: Expended Energy present
  // bit9: Heart Rate present
  // bit10: Metabolic Equivalent present
  // bit11: Elapsed Time present
  // bit12: Remaining Time present

  const moreDataBit = flags & 0x0001;

  if (moreDataBit === 0 && dataView.byteLength >= index + 2) {
    const raw = dataView.getUint16(index, true);
    index += 2;
    lastSampleSpeed = raw / 100.0; // km/h
  }

  if (flags & (1 << 1)) {
    if (dataView.byteLength >= index + 2) {
      index += 2; // average speed
    }
  }

  if (flags & (1 << 2)) {
    if (dataView.byteLength >= index + 2) {
      const rawCad = dataView.getUint16(index, true);
      index += 2;
      lastSampleCadence = rawCad / 2.0;
    }
  }

  if (flags & (1 << 3)) {
    if (dataView.byteLength >= index + 2) {
      index += 2; // avg cadence
    }
  }

  if (flags & (1 << 4)) {
    if (dataView.byteLength >= index + 3) {
      index += 3; // distance
    }
  }

  if (flags & (1 << 5)) {
    if (dataView.byteLength >= index + 1) {
      index += 1; // resistance level
    }
  }

  if (flags & (1 << 6)) {
    if (dataView.byteLength >= index + 2) {
      const power = dataView.getInt16(index, true);
      index += 2;
      lastSamplePower = power;
    }
  }

  if (flags & (1 << 7)) {
    if (dataView.byteLength >= index + 2) {
      index += 2; // avg power
    }
  }

  if (flags & (1 << 8)) {
    if (dataView.byteLength >= index + 5) {
      index += 5; // expended energy
    }
  }

  if (flags & (1 << 9)) {
    if (dataView.byteLength >= index + 1) {
      const hr = dataView.getUint8(index);
      index += 1;
      if (!isHrAvailable) {
        lastSampleHr = hr;
      }
    }
  }

  if (flags & (1 << 10)) {
    if (dataView.byteLength >= index + 1) index += 1; // MET
  }
  if (flags & (1 << 11)) {
    if (dataView.byteLength >= index + 2) index += 2; // elapsed time
  }
  if (flags & (1 << 12)) {
    if (dataView.byteLength >= index + 2) index += 2; // remaining time
  }

  logDebug(
    `FTMS <- IndoorBikeData: flags=0x${flags
      .toString(16)
      .padStart(4, "0")}, power=${lastSamplePower ?? "n/a"}W, cad=${lastSampleCadence != null ? lastSampleCadence.toFixed(1) : "n/a"
    }rpm`
  );

  if (lastSamplePower) {
    maybeAutoStartFromPower(lastSamplePower);
  }

  // Keep HUD live even when paused
  updateStatsDisplay();
}

function parseHrMeasurement(dataView) {
  if (!dataView || dataView.byteLength < 2) return;
  let offset = 0;
  const flags = dataView.getUint8(offset);
  offset += 1;
  const is16bit = (flags & 0x1) !== 0;
  if (is16bit && dataView.byteLength >= offset + 2) {
    lastSampleHr = dataView.getUint16(offset, true);
  } else if (!is16bit) {
    lastSampleHr = dataView.getUint8(offset);
  }

  logDebug(`HRM <- HeartRateMeasurement: hr=${lastSampleHr}bpm`);

  updateStatsDisplay();
}

// --------------------------- Battery reporting ---------------------------

function updateBikeBatteryLabel() {
  if (!bikeBatteryLabel) return;
  if (bikeBatteryPercent == null) {
    bikeBatteryLabel.textContent = "";
    bikeBatteryLabel.classList.remove("battery-low");
    return;
  }
  bikeBatteryLabel.textContent = `${bikeBatteryPercent}%`;
  bikeBatteryLabel.classList.toggle(
    "battery-low",
    bikeBatteryPercent <= 20
  );
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

// --------------------------- BLE connect ---------------------------

// type: "bike" | "hr"
async function connectToDevice(device, type) {
  if (!device) return;
  bluetoothDevice = device;

  bluetoothDevice.addEventListener("gattserverdisconnected", () => {
    logDebug(`BLE disconnected (${type}).`);
    if (type === "bike") {
      isBikeConnected = false;
      setBikeStatus("error");
    } else {
      isHrAvailable = false;
      setHrStatus("error");
    }
  });

  if (type === "bike") {
    isBikeConnecting = true;
    setBikeStatus("connecting");
  } else {
    setHrStatus("connecting");
  }

  logDebug(`Connecting to GATT server for ${type}…`);
  gattServer = await bluetoothDevice.gatt.connect();
  logDebug("Connected to GATT server.");

  try {
    if (chrome && chrome.storage && chrome.storage.local && type === "bike") {
      chrome.storage.local.set({[STORAGE_LAST_DEVICE_ID]: bluetoothDevice.id});
    }
  } catch {}

  if (type === "bike") {
    ftmsService = await gattServer.getPrimaryService(FTMS_SERVICE_UUID).catch((err) => {
      logDebug("Error getting FTMS service: " + err);
      return null;
    });
    logDebug("FTMS service " + (ftmsService ? "found" : "not found"));
  }

  heartRateService = await gattServer
    .getPrimaryService(HEART_RATE_SERVICE_UUID)
    .catch(() => null);

  batteryService = await gattServer
    .getPrimaryService(BATTERY_SERVICE_UUID)
    .catch(() => null);

  if (type === "bike" && ftmsService) {
    indoorBikeDataChar = await ftmsService
      .getCharacteristic(INDOOR_BIKE_DATA_CHAR)
      .catch((err) => {
        logDebug("Error getting IndoorBikeData characteristic: " + err);
        return null;
      });
    ftmsControlPointChar = await ftmsService
      .getCharacteristic(FTMS_CONTROL_POINT_CHAR)
      .catch((err) => {
        logDebug("Error getting FTMS Control Point characteristic: " + err);
        return null;
      });

    if (ftmsControlPointChar) {
      ftmsControlPointChar.addEventListener(
        "characteristicvaluechanged",
        (ev) => {
          const dv = ev.target.value;
          if (!dv || dv.byteLength < 3) return;
          const op = dv.getUint8(0);
          const reqOp = dv.getUint8(1);
          const resCode = dv.getUint8(2);
          logDebug(
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
      try {
        await ftmsControlPointChar.startNotifications();
        logDebug("Subscribed to FTMS Control Point indications.");
      } catch (err) {
        logDebug(
          "Could not start FTMS Control Point indications (may still work): " +
          err
        );
      }
    }
  }

  if (heartRateService) {
    hrMeasurementChar = await heartRateService
      .getCharacteristic(HR_MEASUREMENT_CHAR)
      .catch((err) => {
        logDebug("Error getting HR measurement characteristic: " + err);
        return null;
      });
  }

  if (batteryService) {
    try {
      const batteryLevelChar = await batteryService.getCharacteristic(
        BATTERY_LEVEL_CHAR
      );
      const val = await batteryLevelChar.readValue();
      const pct = val.getUint8(0);
      logDebug(`${type.toUpperCase()} battery: ${pct}%`);
      if (type === "bike") {
        bikeBatteryPercent = pct;
        updateBikeBatteryLabel();
      } else {
        hrBatteryPercent = pct;
        updateHrBatteryLabel();
      }
    } catch (err) {
      logDebug("Battery read failed: " + err);
    }
  }

  if (type === "bike" && indoorBikeDataChar) {
    indoorBikeDataChar.addEventListener(
      "characteristicvaluechanged",
      (ev) => {
        const dv = ev.target.value;
        parseIndoorBikeData(dv);
      }
    );
    await indoorBikeDataChar.startNotifications();
    logDebug("Subscribed to FTMS Indoor Bike Data (0x2AD2).");
  }

  if (type === "bike" && ftmsControlPointChar) {
    try {
      await sendFtmsControlPoint(FTMS_OPCODES.requestControl, null);
      await sendFtmsControlPoint(FTMS_OPCODES.startOrResume, null);
      logDebug("FTMS requestControl + startOrResume sent.");
    } catch (err) {
      logDebug("Failed to send FTMS requestControl/startOrResume: " + err);
    }
  }

  if (hrMeasurementChar) {
    await hrMeasurementChar.startNotifications();
    hrMeasurementChar.addEventListener("characteristicvaluechanged", (ev) => {
      parseHrMeasurement(ev.target.value);
    });
    isHrAvailable = true;
    setHrStatus("connected");
    logDebug("Subscribed to HRM Measurement (0x2A37).");
  } else if (type === "hr") {
    isHrAvailable = false;
    setHrStatus("error");
  }

  if (type === "bike") {
    isBikeConnecting = false;
    isBikeConnected = true;
    setBikeStatus("connected");
    logDebug("Bike BLE ready, sending initial trainer state.");
    await sendTrainerState(true);
  } else {
    logDebug("HR BLE ready.");
  }
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

  let shouldBeep = true;
  if (next) {
    const currEnd =
      segment.targetWattsEnd != null
        ? segment.targetWattsEnd
        : segment.pEndRel * ftp;
    const nextStart =
      next.targetWattsStart != null
        ? next.targetWattsStart
        : next.pStartRel * ftp;
    if (currEnd > 0) {
      const diffFrac = Math.abs(nextStart - currEnd) / currEnd;
      if (diffFrac < 0.2) {
        shouldBeep = false;
      }
    }
  }

  if (!shouldBeep) return;

  const secsToEnd = segment.endTimeSec - currentT;
  if (secsToEnd === 3 || secsToEnd === 2 || secsToEnd === 1) {
    playBeep(120, 880, 0.4);
  }
  if (Math.floor(currentT) === segment.endTimeSec) {
    playBeep(220, 660, 0.5);
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

    // Auto-resume check runs even when paused
    if (mode === "workout" && workoutRunning && workoutPaused) {
      const currentTarget = getCurrentTargetPower();
      if (currentTarget && lastSamplePower) {
        if (lastSamplePower >= 0.9 * currentTarget) {
          logDebug("Auto-resume: power high vs target (>=90%).");
          autoPauseDisabledUntilSec = elapsedSec + AUTO_PAUSE_GRACE_SEC;
          showResumedOverlay();
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
    goBackBtn.style.display = "";
    return;
  }

  startBtn.style.display = "none";
  goBackBtn.style.display = "none";

  if (mode === "workout") {
    if (workoutPaused) {
      const play = createPlayButton();
      const stop = createStopButton();
      workoutControls.appendChild(play);
      workoutControls.appendChild(stop);
    } else {
      const pause = createPauseButton();
      const stop = createStopButton();
      workoutControls.appendChild(pause);
      workoutControls.appendChild(stop);
    }
  } else {
    const stop = createStopButton();
    workoutControls.appendChild(stop);
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
    showPausedOverlay();
  }
  updatePlaybackButtons();
}

// --------------------------- Start / stop workout ---------------------------

function startWorkout() {
  if (!workoutMeta || !scaledSegments.length) {
    alert("No workout selected. Choose a workout in the options page.");
    return;
  }

  if (!workoutRunning) {
    logDebug("Starting workout (countdown)...");
    runStartCountdown(async () => {
      liveSamples = [];
      elapsedSec = 0;
      intervalElapsedSec = scaledSegments[0]?.durationSec || 0;
      currentIntervalIndex = 0;
      workoutStartedAt = new Date();
      workoutStartEpochMs = Date.now();
      zeroPowerSeconds = 0;
      autoPauseDisabledUntilSec = elapsedSec + AUTO_PAUSE_GRACE_SEC;

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
    showResumedOverlay();
    setWorkoutPaused(false);
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
    ftpInline.style.display = "none";
    workoutNameLabel.style.display = "flex";
    if (workoutRunning) setWorkoutPaused(true);
  } else if (mode === "resistance") {
    manualControls.style.display = "inline-flex";
    manualValueEl.textContent = String(manualResistance);
    ftpInline.style.display = "none";
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

  darkModeCached = detectDarkMode();
  if (window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => {
      darkModeCached = e.matches;
      rerenderThemeSensitive();
    };
    if (mql.addEventListener) mql.addEventListener("change", handler);
    else if (mql.addListener) mql.addListener(handler);
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
  setupChartHover();

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
    workoutPaused = true; // restore in paused state
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

  bikeConnectBtn.addEventListener("click", async () => {
    if (!navigator.bluetooth) {
      alert("Bluetooth not available in this browser.");
      return;
    }
    try {
      const device = await requestBikeDevice();
      await connectToDevice(device, "bike");
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
      const device = await requestHrDevice();
      await connectToDevice(device, "hr");
    } catch (err) {
      logDebug("BLE connect canceled or failed (HRM): " + err);
      setHrStatus("error");
    }
  });

  logsBtn.addEventListener("click", () => {
    debugOverlay.style.display = "flex";
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

  goBackBtn.addEventListener("click", () => {
    if (!workoutRunning) {
      navigateToOptionsReplace();
    }
  });

  document.addEventListener("keydown", (e) => {
    // Space: start/resume workout
    if (e.code === "Space") {
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (mode !== "workout") return;
      e.preventDefault();
      startWorkout();
      return;
    }

    // Escape: close logs overlay
    if (e.key === "Escape") {
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

