// options.js

const DEFAULT_FTP = 250;

// ---------------- Global state ----------------

const DB_NAME = "zwo-downloader";
const DB_VERSION = 1;

let dbPromise = null;
let currentDirHandle = null;
let currentWorkouts = [];
let currentFtp = DEFAULT_FTP;
let currentExpandedKey = null; // fileName of expanded row (or null)

let currentSortKey = "kjAdj";   // "if", "tss", "kjAdj", "duration", "name"
let currentSortDir = "asc";     // "asc" | "desc"

// ---------------- FTP helpers (chrome.storage.sync) ----------------

function clampFtp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_FTP;
  return Math.min(500, Math.max(50, Math.round(n)));
}

function loadFtp() {
  const input = document.getElementById("ftpInput");
  if (!input) return;

  try {
    if (!chrome || !chrome.storage || !chrome.storage.sync) {
      currentFtp = DEFAULT_FTP;
      input.value = DEFAULT_FTP;
      return;
    }
  } catch {
    currentFtp = DEFAULT_FTP;
    input.value = DEFAULT_FTP;
    return;
  }

  chrome.storage.sync.get({ftp: DEFAULT_FTP}, (data) => {
    const v = clampFtp(data.ftp);
    currentFtp = v;
    input.value = v;
    recomputeKjAndRender();
  });
}

// auto-save FTP when edited
function setupFtpInput() {
  const input = document.getElementById("ftpInput");
  if (!input) return;

  let lastSaved = currentFtp;

  const save = (value) => {
    const v = clampFtp(value);
    currentFtp = v;
    input.value = v;
    if (v === lastSaved) {
      recomputeKjAndRender();
      return;
    }

    try {
      if (!chrome || !chrome.storage || !chrome.storage.sync) {
        recomputeKjAndRender();
        return;
      }
    } catch {
      recomputeKjAndRender();
      return;
    }

    chrome.storage.sync.set({ftp: v}, () => {
      lastSaved = v;
      recomputeKjAndRender();
    });
  };

  let debounceTimer = null;
  input.addEventListener("input", () => {
    const raw = input.value;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      save(raw);
    }, 400);
  });
}

// ---------------- IndexedDB helpers for directory handle ----------------

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

async function saveDirectoryHandle(handle) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readwrite");
    const store = tx.objectStore("settings");
    const value = {key: "dirHandle", handle};
    store.put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadDirectoryHandle() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readonly");
    const store = tx.objectStore("settings");
    const req = store.get("dirHandle");
    req.onsuccess = () => {
      resolve(req.result ? req.result.handle : null);
    };
    req.onerror = () => reject(req.error);
  });
}

async function ensureDirPermission(handle) {
  if (!handle) return false;
  if (!handle.queryPermission || !handle.requestPermission) return true;

  const current = await handle.queryPermission({mode: "readwrite"});
  if (current === "granted") return true;
  if (current === "denied") return false;

  const result = await handle.requestPermission({mode: "readwrite"});
  return result === "granted";
}

// ---------------- Metrics / category helpers ----------------

// segments: [{ durationSec, pStartRel, pEndRel }]
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
      ftp: ftpVal > 0 ? ftpVal : null
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
      ftp: ftpVal
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
    ftp: ftpVal
  };
}

// infer zone-category from segments like [minutes, startPct, endPct?]
function inferCategoryFromSegments(rawSegments) {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return "Uncategorized";
  }

  const zoneTime = {
    recovery: 0,   // < 55%
    base: 0,       // 55–75%
    tempo: 0,      // 76–87%
    sweetSpot: 0,  // 88–94%
    threshold: 0,  // 95–105%
    vo2: 0,        // 106–120%
    anaerobic: 0   // > 120%
  };

  let totalSec = 0;
  let workSec = 0; // time at/above ~tempo (>= 75% FTP)

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
    if (avgPct < 55) zoneKey = "recovery";
    else if (avgPct < 76) zoneKey = "base";
    else if (avgPct < 88) zoneKey = "tempo";
    else if (avgPct < 95) zoneKey = "sweetSpot";
    else if (avgPct < 106) zoneKey = "threshold";
    else if (avgPct < 121) zoneKey = "vo2";
    else zoneKey = "anaerobic";

    zoneTime[zoneKey] += durSec;

    if (avgPct >= 75) {
      workSec += durSec;
    }
  }

  if (totalSec === 0) return "Uncategorized";

  const z = zoneTime;
  const hiSec = z.vo2 + z.anaerobic;
  const thrSec = z.threshold;
  const ssSec = z.sweetSpot;
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
    ss: ssSec / safeDiv,
    tempo: tempoSec / safeDiv
  };

  if (fracWork.hi >= 0.25) {
    const anaerFrac = z.anaerobic / safeDiv;
    if (anaerFrac >= 0.15) {
      return "HIIT";
    }
    return "VO2Max";
  }

  if (fracWork.thr + fracWork.hi >= 0.4) {
    return "Threshold";
  }

  if (fracWork.ss + fracWork.thr >= 0.4 || fracWork.ss >= 0.3) {
    return "SweetSpot";
  }

  if (fracWork.tempo >= 0.5) {
    return "SweetSpot";
  }

  return "Base";
}

// ---------------- ZWO parsing ----------------

// Build segments from ZWO <workout> children
// Returns { segmentsForMetrics, segmentsForCategory }
function extractSegmentsFromZwo(doc) {
  const workoutEl = doc.querySelector("workout_file > workout");
  if (!workoutEl) return {segmentsForMetrics: [], segmentsForCategory: []};

  const segments = [];
  const rawSegments = []; // [minutes, pctLow, pctHigh]

  const children = Array.from(workoutEl.children);

  function pushSeg(durationSec, pLow, pHigh) {
    segments.push({
      durationSec,
      pStartRel: pLow,
      pEndRel: pHigh
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
    segmentsForCategory: rawSegments
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
    segmentsForCategory
  };
}

// ---------------- Directory + scanning ----------------

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
    console.error("[ZWO Options] Error scanning workouts:", err);
  }
  return workouts;
}

// recompute adjusted kJ for all workouts and re-render
function recomputeKjAndRender() {
  renderWorkoutManager();
}

// ---------------- Filtering, sorting, and rendering ----------------

function getAdjustedKj(workout) {
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

function refreshCategoryFilter() {
  const select = document.getElementById("categoryFilter");
  if (!select) return;

  const valueBefore = select.value;
  const cats = Array.from(
    new Set(currentWorkouts.map((w) => w.category || "Uncategorized"))
  ).sort((a, b) => a.localeCompare(b));

  select.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "All categories";
  select.appendChild(optAll);

  for (const c of cats) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    select.appendChild(opt);
  }

  if (cats.includes(valueBefore)) {
    select.value = valueBefore;
  }
}

function setupSorting() {
  const headerCells = document.querySelectorAll("th[data-sort-key]");
  headerCells.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort-key");
      if (!key) return;
      if (currentSortKey === key) {
        currentSortDir = currentSortDir === "asc" ? "desc" : "asc";
      } else {
        currentSortKey = key;
        currentSortDir = key === "kjAdj" ? "asc" : "desc";
      }
      renderWorkoutManager();
    });
  });
  updateSortHeaderIndicator();
}

function updateSortHeaderIndicator() {
  const headers = document.querySelectorAll("th[data-sort-key]");
  headers.forEach((th) => {
    const key = th.getAttribute("data-sort-key");
    th.classList.remove("sorted-asc", "sorted-desc");
    if (key === currentSortKey) {
      th.classList.add(currentSortDir === "asc" ? "sorted-asc" : "sorted-desc");
    }
  });
}

function renderWorkoutManager() {
  const tbody = document.getElementById("workoutTbody");
  const searchInput = document.getElementById("searchInput");
  const categoryFilter = document.getElementById("categoryFilter");
  const durationFilter = document.getElementById("durationFilter");
  const summaryEl = document.getElementById("managerSummary");
  const workoutManager = document.getElementById("workoutManager");

  if (!tbody || !workoutManager) return;

  if (currentWorkouts.length === 0) {
    workoutManager.classList.remove("hidden");
    tbody.innerHTML = "";
    if (summaryEl) summaryEl.textContent = "No .zwo files found in this folder yet.";
    updateSortHeaderIndicator();
    return;
  }

  workoutManager.classList.remove("hidden");

  const searchTerm = (searchInput && searchInput.value || "").toLowerCase();
  const catValue = (categoryFilter && categoryFilter.value) || "";
  const durValue = (durationFilter && durationFilter.value) || "";

  let shown = currentWorkouts;

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
        (w.description || "").slice(0, 300)
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(searchTerm);
    });
  }

  // sort
  const sortKey = currentSortKey;
  const dir = currentSortDir === "asc" ? 1 : -1;

  shown = shown.slice().sort((a, b) => {
    function num(val) {
      return Number.isFinite(val) ? val : -Infinity;
    }
    if (sortKey === "kjAdj") {
      return (num(getAdjustedKj(a)) - num(getAdjustedKj(b))) * dir;
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

  tbody.innerHTML = "";

  const total = currentWorkouts.length;
  const shownCount = shown.length;
  if (summaryEl) summaryEl.textContent = `${shownCount} of ${total} workouts shown`;

  const colCount = 7; // Name, Category, Source, IF, TSS, Duration, kJ

  for (const w of shown) {
    const key = w.fileName || w.name;
    const tr = document.createElement("tr");
    tr.className = "workout-row";
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

    const adjKj = getAdjustedKj(w);
    const tdKj = document.createElement("td");
    tdKj.textContent = adjKj != null ? `${Math.round(adjKj)} kJ` : "";
    tr.appendChild(tdKj);

    tbody.appendChild(tr);

    // Expansion row
    const expanded = currentExpandedKey === key;
    if (expanded) {
      const expTr = document.createElement("tr");
      expTr.className = "workout-expanded-row";
      const expTd = document.createElement("td");
      expTd.colSpan = colCount;

      const container = document.createElement("div");
      container.className = "workout-expanded";

      const graphDiv = document.createElement("div");
      graphDiv.className = "workout-graph";

      const detailDiv = document.createElement("div");
      detailDiv.className = "workout-detail";

      if (w.description && w.description.trim()) {
        const descHtml = w.description.replace(/\n/g, "<br>");
        detailDiv.innerHTML = descHtml;
      } else {
        detailDiv.textContent = "(No description)";
      }

      container.appendChild(graphDiv);
      container.appendChild(detailDiv);
      expTd.appendChild(container);
      expTr.appendChild(expTd);
      tbody.appendChild(expTr);

      renderWorkoutGraph(graphDiv, w);
    }

    // Row click toggles expansion
    tr.addEventListener("click", () => {
      if (currentExpandedKey === key) {
        currentExpandedKey = null;
      } else {
        currentExpandedKey = key;
      }
      renderWorkoutManager();
    });
  }

  updateSortHeaderIndicator();
}

// ---------------- Graph rendering ----------------

function getZoneInfo(pct) {
  if (pct < 55) return {key: "Recovery", color: "#b0bec5"};
  if (pct < 76) return {key: "Base", color: "#81c784"};
  if (pct < 88) return {key: "Tempo", color: "#ffb74d"};
  if (pct < 95) return {key: "SweetSpot", color: "#ff8a65"};
  if (pct < 106) return {key: "Threshold", color: "#e57373"};
  if (pct < 121) return {key: "VO2Max", color: "#ba68c8"};
  return {key: "Anaerobic", color: "#9575cd"};
}

function renderWorkoutGraph(container, workout) {
  container.innerHTML = "";

  const segments = workout.segmentsForMetrics || [];
  if (!segments.length || !Number.isFinite(workout.totalSec) || workout.totalSec <= 0) {
    container.textContent = "No workout structure available.";
    return;
  }

  const width = 400;
  const height = 120;
  const maxRel = 1.4; // y-axis max relative to FTP

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("workout-graph-svg");

  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", width);
  bg.setAttribute("height", height);
  bg.setAttribute("fill", "transparent");
  svg.appendChild(bg);

  const yBottom = height;

  let tCursor = 0;
  for (const seg of segments) {
    const dur = Math.max(1, Number(seg.durationSec) || 0);
    const p0 = Number(seg.pStartRel) || 0;
    const p1 = Number(seg.pEndRel) || 0;

    const x = (tCursor / workout.totalSec) * width;
    const w = (dur / workout.totalSec) * width;

    const avgRel = (p0 + p1) / 2;
    const zone = getZoneInfo(avgRel * 100);

    const p0Clamped = Math.min(maxRel, Math.max(0, p0));
    const p1Clamped = Math.min(maxRel, Math.max(0, p1));

    const y0 = height * (1 - p0Clamped / maxRel);
    const y1 = height * (1 - p1Clamped / maxRel);

    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    const points = `${x},${yBottom} ${x},${y0} ${x + w},${y1} ${x + w},${yBottom}`;
    poly.setAttribute("points", points);
    poly.setAttribute("fill", zone.color);

    poly.dataset.zone = zone.key;
    poly.dataset.p0 = (p0 * 100).toFixed(0);
    poly.dataset.p1 = (p1 * 100).toFixed(0);
    poly.dataset.durMin = (dur / 60).toFixed(1);

    svg.appendChild(poly);

    tCursor += dur;
  }

  const tooltip = document.createElement("div");
  tooltip.className = "workout-tooltip";
  tooltip.style.position = "absolute";
  tooltip.style.pointerEvents = "none";
  tooltip.style.fontSize = "11px";
  tooltip.style.padding = "4px 6px";
  tooltip.style.borderRadius = "4px";
  tooltip.style.background = "rgba(0,0,0,0.8)";
  tooltip.style.color = "#fff";
  tooltip.style.whiteSpace = "nowrap";
  tooltip.style.display = "none";
  tooltip.style.zIndex = "5";

  container.style.position = "relative";
  container.appendChild(svg);
  container.appendChild(tooltip);

  svg.addEventListener("mousemove", (e) => {
    const target = e.target;
    if (!(target instanceof SVGElement) || !target.dataset.zone) {
      tooltip.style.display = "none";
      return;
    }

    const zone = target.dataset.zone;
    const p0 = target.dataset.p0;
    const p1 = target.dataset.p1;
    const durMin = target.dataset.durMin;

    tooltip.textContent = `${zone}: ${p0}%–${p1}% FTP, ${durMin} min`;
    tooltip.style.display = "block";

    const rect = container.getBoundingClientRect();
    const tx = e.clientX - rect.left + 8;
    const ty = e.clientY - rect.top + 8;
    tooltip.style.left = `${tx}px`;
    tooltip.style.top = `${ty}px`;
  });

  svg.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
  });
}

// ---------------- Directory + manager init ----------------

async function initDirectoryAndManager() {
  const dirSupportNote = document.getElementById("dirSupportNote");
  const dirCurrentEl = document.getElementById("dirCurrent");
  const workoutManager = document.getElementById("workoutManager");
  const chooseDirBtn = document.getElementById("chooseDirBtn");
  const rescanBtn = document.getElementById("rescanBtn");
  const searchInput = document.getElementById("searchInput");
  const categoryFilter = document.getElementById("categoryFilter");
  const durationFilter = document.getElementById("durationFilter");

  if (!("showDirectoryPicker" in window)) {
    if (dirSupportNote) {
      dirSupportNote.textContent = "Folder selection requires a recent Chromium-based browser.";
    }
    if (chooseDirBtn) chooseDirBtn.disabled = true;
    if (rescanBtn) rescanBtn.disabled = true;
    if (workoutManager) workoutManager.classList.add("hidden");
    return;
  } else if (dirSupportNote) {
    dirSupportNote.textContent = "";
  }

  try {
    const handle = await loadDirectoryHandle();
    if (handle) {
      const ok = await ensureDirPermission(handle);
      if (ok) {
        currentDirHandle = handle;
        if (dirCurrentEl) {
          dirCurrentEl.textContent = handle.name || "(selected folder)";
        }
        await rescanWorkouts();
      } else {
        if (dirCurrentEl) {
          dirCurrentEl.textContent = "Folder permission not granted.";
        }
        if (workoutManager) workoutManager.classList.add("hidden");
      }
    } else {
      if (dirCurrentEl) dirCurrentEl.textContent = "No folder selected.";
      if (workoutManager) workoutManager.classList.add("hidden");
    }
  } catch (err) {
    console.error("[ZWO Options] Error loading directory handle:", err);
    if (dirCurrentEl) dirCurrentEl.textContent = "No folder selected.";
  }

  if (chooseDirBtn) {
    chooseDirBtn.addEventListener("click", async () => {
      try {
        const handle = await window.showDirectoryPicker();
        const ok = await ensureDirPermission(handle);
        if (!ok) {
          if (dirCurrentEl) {
            dirCurrentEl.textContent = "Permission denied.";
          }
          if (workoutManager) workoutManager.classList.add("hidden");
          return;
        }
        currentDirHandle = handle;
        await saveDirectoryHandle(handle);
        if (dirCurrentEl) {
          dirCurrentEl.textContent = handle.name || "(selected folder)";
        }
        await rescanWorkouts();
      } catch (err) {
        if (err && err.name === "AbortError") {
          return; // user canceled
        }
        console.error("[ZWO Options] Error choosing directory:", err);
        if (dirCurrentEl) {
          dirCurrentEl.textContent = "Failed to choose folder.";
        }
      }
    });
  }

  if (rescanBtn) {
    rescanBtn.addEventListener("click", async () => {
      await rescanWorkouts();
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderWorkoutManager();
    });
  }

  if (categoryFilter) {
    categoryFilter.addEventListener("change", () => {
      renderWorkoutManager();
    });
  }

  if (durationFilter) {
    durationFilter.addEventListener("change", () => {
      renderWorkoutManager();
    });
  }

  setupSorting();
}

async function rescanWorkouts() {
  const workoutManager = document.getElementById("workoutManager");
  const dirCurrentEl = document.getElementById("dirCurrent");

  if (!currentDirHandle) {
    if (workoutManager) workoutManager.classList.add("hidden");
    if (dirCurrentEl) dirCurrentEl.textContent = "No folder selected.";
    currentWorkouts = [];
    renderWorkoutManager();
    return;
  }

  const ok = await ensureDirPermission(currentDirHandle);
  if (!ok) {
    if (workoutManager) workoutManager.classList.add("hidden");
    if (dirCurrentEl) dirCurrentEl.textContent = "Folder permission lost.";
    currentWorkouts = [];
    renderWorkoutManager();
    return;
  }

  if (dirCurrentEl) {
    dirCurrentEl.textContent = currentDirHandle.name || "(selected folder)";
  }

  currentExpandedKey = null;
  currentWorkouts = await scanWorkoutsFromDirectory(currentDirHandle);
  refreshCategoryFilter();
  renderWorkoutManager();
}

// ---------------- init ----------------

document.addEventListener("DOMContentLoaded", () => {
  setupFtpInput();
  loadFtp();
  initDirectoryAndManager().catch((err) => {
    console.error("[ZWO Options] init error:", err);
  });
});

