// scrapers.js
//
// Site-specific scrapers that turn web pages / URLs into CanonicalWorkout
// instances and optional ZWO snippets.
//
// Depends on zwo.js for the canonical → ZWO transformation.

/** @typedef {import('./zwo.js').CanonicalWorkout} CanonicalWorkout */

// ---------------- Site detection regexes (for parsers) ----------------

const TRAINERROAD_WORKOUT_REGEX =
  /\/app\/cycling\/workouts\/add\/(\d+)(?:\/|$)/;
const TRAINERDAY_WORKOUT_REGEX = /^\/workouts\/([^/?#]+)/;
const WHATSONZWIFT_WORKOUT_REGEX = /^\/workouts\/.+/;

// ---------------- Small helpers (fetch / JSON) ----------------

/**
 * fetchJson with basic CORS / extension-host-permission detection.
 *
 * In a Chrome extension options page, blocked cross-origin requests often show
 * up as TypeError while the browser is online. We mark these as corsError
 * so callers can present better remediation instructions.
 */
async function fetchJson(url, options = {}) {
  try {
    const res = await fetch(url, options);

    // --- HTTP errors ---
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.url = url;
      throw err;
    }

    // --- Parse JSON ---
    try {
      return await res.json();
    } catch (jsonErr) {
      const err = new Error("Invalid JSON");
      err.url = url;
      err.cause = jsonErr;
      throw err;
    }

  } catch (err) {
    // Determine whether we were online (Chrome extension CORS check)
    const online =
      typeof navigator === "undefined"
        ? true
        : navigator.onLine;

    // --- CORS / site-access blocking (Chrome extension) ---
    if (err instanceof TypeError && online) {
      const corsErr = new Error(
        "Request was blocked by the browser (CORS / site access)."
      );
      corsErr.isCorsError = true;
      corsErr.url = url;
      throw corsErr;
    }

    // --- Offline or DNS failure ---
    if (err instanceof TypeError && !online) {
      const netErr = new Error("Network request failed (offline).");
      netErr.isNetworkError = true;
      netErr.url = url;
      throw netErr;
    }

    // --- Fallthrough: already-structured error (HTTP or JSON) ---
    throw err;
  }
}

async function fetchTrainerRoadJson(url, options = {}) {
  return fetchJson(url, {
    credentials: "include",
    headers: {
      "trainerroad-jsonformat": "camel-case",
    },
    ...options,
  });
}

async function fetchTrainerDayWorkoutBySlug(slug) {
  const url = `https://app.api.trainerday.com/api/workouts/bySlug/${encodeURIComponent(
    slug
  )}`;
  return fetchJson(url, {credentials: "omit"});
}

// ---------------- Text helpers ----------------

/**
 * Ensure descriptions are plain text:
 *  - Converts some common block tags to newlines
 *  - Strips all remaining HTML tags
 *  - Normalizes whitespace
 *
 * @param {unknown} value
 * @returns {string}
 */
function toPlainText(value) {
  if (typeof value !== "string") return "";

  return value
    // convert common line-break tags to actual newlines
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<\/div\s*>/gi, "\n\n")
    // strip all remaining tags
    .replace(/<[^>]*>/g, "")
    // normalize whitespace
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------- Parsers for each site -> CanonicalWorkout -----------
//
// Each parser returns a tuple: [CanonicalWorkout|null, string|null]
//   - On success: [canonicalWorkout, null]
//   - On failure: [null, "user-friendly error message"]

// ---------- TrainerRoad ----------
/**
 * Convert TrainerRoad chart "course data" into canonical [minutes, startPower, endPower].
 *
 * Assumptions:
 *  - courseData is an array of { ftpPercent: number, ... }
 *  - entries are already in chronological order
 *  - there is exactly 1 row per second
 *  - underlying workout is flats + ramps aligned to second boundaries
 *  - ramps are at least 2 seconds long
 *
 * Output:
 *  - [segments, errorStringOrNull]
 *    where segments is Array<[minutes, ftpPercentBegin, ftpPercentEnd]>
 *
 * @param {Array<{ftpPercent: number}>} courseData
 * @returns {[Array<[number, number, number]>, (string|null)]}
 */
function canonicalizeTrainerRoadSegments(courseData) {
  const errorPrefix = "Invalid courseData: ";

  // Basic shape check
  if (!Array.isArray(courseData)) {
    return [[], errorPrefix + "must be an array"];
  }
  const n = courseData.length;
  if (n === 0) {
    return [[], errorPrefix + "array is empty"];
  }

  // Extract ftpPercent as numbers
  const ftp = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = courseData[i] || {};
    const val = Number(row.ftpPercent);
    if (!Number.isFinite(val)) {
      return [
        [],
        errorPrefix + `row ${i} must have numeric 'ftpPercent'`,
      ];
    }
    ftp[i] = val;
  }

  // Single-point workout: treat as a 1-second flat segment
  if (n === 1) {
    const seconds = 1;
    const minutes = seconds / 60;
    const p = ftp[0];
    return [[[minutes, p, p]], null];
  }

  // Compute per-second deltas on each edge (i -> i+1)
  const deltas = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    deltas[i] = ftp[i + 1] - ftp[i];
  }

  const segments = [];
  const EPS = 1e-3; // less strict: treat tiny slope differences as equal
  const almostEqual = (a, b) => Math.abs(a - b) <= EPS;

  // Helper: push a segment defined by a run of edges [edgeStart .. edgeEnd] inclusive
  function pushSegment(edgeStart, edgeEnd) {
    if (edgeStart > edgeEnd) return;

    const startSample = edgeStart;
    const endSample = edgeEnd + 1; // edge i is between sample i and i+1

    const seconds = endSample - startSample; // 1 second per edge
    if (seconds <= 0) return;

    const minutes = seconds / 60;
    const startPower = ftp[startSample];
    const endPower = ftp[endSample];

    segments.push([minutes, startPower, endPower]);
  }

  // Run-length encode contiguous equal deltas
  let edgeRunStart = 0;
  for (let edge = 1; edge < n - 1; edge++) {
    if (!almostEqual(deltas[edge], deltas[edgeRunStart])) {
      // Close the previous run [edgeRunStart .. edge-1]
      pushSegment(edgeRunStart, edge - 1);
      edgeRunStart = edge;
    }
  }
  // Flush the final run [edgeRunStart .. n-2]
  pushSegment(edgeRunStart, n - 2);

  // --- Post-process: remove spurious 1-second ramps (steps) -------------
  // If a segment is exactly 1 second long AND is not flat, treat it as a step:
  // extend the previous segment by 1s and drop this segment.
  const cleaned = [];
  const SEC_EPS = 1e-6;
  for (let i = 0; i < segments.length; i++) {
    const [minutes, startPower, endPower] = segments[i];
    const seconds = minutes * 60;

    const isOneSecond = Math.abs(seconds - 1) <= SEC_EPS;
    const isRamp = !almostEqual(startPower, endPower);

    if (
      i > 0 &&         // we have a previous segment to extend
      isOneSecond &&
      isRamp
    ) {
      // Extend previous segment by 1 second and drop this 1s ramp.
      cleaned[cleaned.length - 1][0] += minutes;
      continue;
    }

    cleaned.push(segments[i]);
  }

  if (!cleaned.length) {
    return [
      [],
      "This TrainerRoad workout doesn’t have intervals VeloDrive can read.",
    ];
  }

  return [cleaned, null];
}


/**
 * Parse the current TrainerRoad workout page into a CanonicalWorkout tuple.
 *       
 * @returns {Promise<[CanonicalWorkout|null, string|null]>}
 */
export async function parseTrainerRoadPage() {
  try {
    if (typeof window === "undefined") {
      return [
        null,
        "VeloDrive can only run on a TrainerRoad workout page in your browser.",
      ];
    }

    const path = window.location.pathname || "";
    let match;

    try {
      match = path.match(TRAINERROAD_WORKOUT_REGEX);
    } catch {
      return [
        null,
        "VeloDrive couldn’t identify this TrainerRoad workout. Try reloading the page.",
      ];
    }

    if (!match || !match[1]) {
      return [
        null,
        "This doesn’t look like a TrainerRoad workout page. Open a workout and try again.",
      ];
    }

    const workoutId = match[1];
    const baseUrl = "https://www.trainerroad.com";

    const chartUrl = `${baseUrl}/app/api/workouts/${workoutId}/chart-data`;
    const summaryUrl = `${baseUrl}/app/api/workouts/${workoutId}/summary?withDifficultyRating=true`;

    let chartData, metaResp;

    // ---- Load data ----------------------------------------------------------
    try {
      [chartData, metaResp] = await Promise.all([
        fetchTrainerRoadJson(chartUrl),
        fetchTrainerRoadJson(summaryUrl),
      ]);
    } catch (err) {
      console.warn("[VeloDrive][TrainerRoad] fetch error:", err);

      if (err.isCorsError) {
        return [
          null,
          "TrainerRoad blocked this request. In Chrome, allow VeloDrive access to trainerroad.com in Extensions → Site Access.",
        ];
      }

      if (err.isNetworkError) {
        return [
          null,
          "You appear to be offline. Check your connection and reload the workout page.",
        ];
      }

      return [
        null,
        "VeloDrive couldn’t load this TrainerRoad workout. Try reloading the page.",
      ];
    }

    // ---- Validate -----------------------------------------------------------
    const courseData = chartData?.courseData;
    if (!Array.isArray(courseData) || courseData.length === 0) {
      return [
        null,
        "This TrainerRoad workout doesn’t contain interval data VeloDrive can read.",
      ];
    }

    // ---- Canonicalize -------------------------------------------------------
    const [rawSegments, err] = canonicalizeTrainerRoadSegments(courseData);
    if (err || rawSegments.length === 0) {
      return [
        null,
        "This TrainerRoad workout doesn’t have intervals VeloDrive can read.",
      ];
    }

    const summary = metaResp?.summary || metaResp || {};

    const workoutTitle =
      summary.workoutName ||
      document.title ||
      "TrainerRoad Workout";

    const description = toPlainText(
      summary.workoutDescription ||
      summary.goalDescription ||
      ""
    );

    /** @type {CanonicalWorkout} */
    const cw = {
      source: "TrainerRoad",
      sourceURL: window.location.href,
      workoutTitle,
      rawSegments,
      description,
      filename: "",
    };

    return [cw, null];

  } catch (err) {
    console.warn("[VeloDrive][TrainerRoad] unexpected parse error:", err);
    return [
      null,
      "VeloDrive couldn’t read this TrainerRoad workout. Try reloading the page.",
    ];
  }
}

// ---------- TrainerDay ----------

// ---------- TrainerDay shared logic ----------

/**
 * Convert TrainerDay segments into canonical [minutes, startPower, endPower].
 * TrainerDay segments are typically [minutes, startPct, endPct?].
 *
 * @param {Array<any>} segments
 * @returns {Array<[number, number, number]>}
 */
function canonicalizeTrainerDaySegments(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];

  for (const seg of segments) {
    if (!Array.isArray(seg) || seg.length < 2) continue;

    const minutes = Number(seg[0]);
    const start = Number(seg[1]);
    const end =
      seg.length > 2 && seg[2] != null ? Number(seg[2]) : start;

    if (
      Number.isFinite(minutes) &&
      minutes > 0 &&
      Number.isFinite(start) &&
      Number.isFinite(end)
    ) {
      out.push([minutes, start, end]);
    }
  }

  return out;
}

/**
 * Extract TrainerDay workout slug from a pathname.
 *
 * @param {string} path
 * @returns {string|null}
 */
function getTrainerDaySlugFromPath(path) {
  const match = path.match(TRAINERDAY_WORKOUT_REGEX);
  return match && match[1] ? match[1] : null;
}

/**
 * Core TrainerDay importer: shared by page + URL wrappers.
 *
 * @param {string} path       e.g. window.location.pathname or url.pathname
 * @param {string} sourceURL  e.g. window.location.href or url.toString()
 * @returns {Promise<[CanonicalWorkout|null, string|null]>}
 */
async function importTrainerDayFromPathAndSource(path, sourceURL) {
  const slug = getTrainerDaySlugFromPath(path || "");
  if (!slug) {
    return [
      null,
      "This TrainerDay link does not look like a workout page.",
    ];
  }

  let details;
  try {
    details = await fetchTrainerDayWorkoutBySlug(slug);
  } catch (err) {
    console.error("[VeloDrive][TrainerDay] fetch error:", err);

    if (err && err.isCorsError) {
      return [
        null,
        "TrainerDay blocked this request. In Chrome, allow VeloDrive access to trainerday.com in Extensions → Site Access.",
      ];
    }

    if (err && err.isNetworkError) {
      return [
        null,
        "You appear to be offline. Check your connection and try again.",
      ];
    }

    return [
      null,
      "VeloDrive couldn’t load this TrainerDay workout. Try again later.",
    ];
  }

  const rawSegments = canonicalizeTrainerDaySegments(
    Array.isArray(details?.segments) ? details.segments : []
  );

  if (!rawSegments.length) {
    console.warn("[VeloDrive][TrainerDay] no usable segments in workout:", details?.segments);
    return [
      null,
      "This TrainerDay workout doesn’t have any intervals that VeloDrive can use.",
    ];
  }

  /** @type {CanonicalWorkout} */
  const canonical = {
    source: "TrainerDay",
    sourceURL,
    workoutTitle: details?.title || "TrainerDay Workout",
    rawSegments,
    description: toPlainText(details?.description || ""),
    filename: "",
  };

  return [canonical, null];
}

// ---------- Page wrapper ----------

/**
 * Parse the current TrainerDay workout page into a CanonicalWorkout tuple.
 *
 * @returns {Promise<[CanonicalWorkout|null, string|null]>}
 */
export async function parseTrainerDayPage() {
  try {
    if (typeof window === "undefined") {
      return [
        null,
        "VeloDrive can only run on a TrainerDay workout page in your browser.",
      ];
    }

    return importTrainerDayFromPathAndSource(
      window.location.pathname,
      window.location.href
    );
  } catch (err) {
    console.warn("[VeloDrive][TrainerDay] parse error:", err);
    return [
      null,
      "VeloDrive couldn’t import this TrainerDay workout. Please reload the page and try again.",
    ];
  }
}

// ---------- URL wrapper ----------

/**
 * Import a TrainerDay workout from a URL object into a CanonicalWorkout.
 *
 * @param {URL} url
 * @returns {Promise<[CanonicalWorkout|null, string|null]>}
 */
export async function importTrainerDayFromUrl(url) {
  try {
    return importTrainerDayFromPathAndSource(
      url.pathname,
      url.toString()
    );
  } catch (err) {
    console.error("[VeloDrive][TrainerDay] URL import error:", err);
    return [
      null,
      "Import from TrainerDay failed. See console for details.",
    ];
  }
}


// ---------- WhatsOnZwift (DOM helpers) ----------

function extractWozTitleFromDoc(doc) {
  const el = doc.querySelector("header.my-8 h1");
  return el ? el.textContent.trim() : "WhatsOnZwift Workout";
}

function extractWozDescriptionFromDoc(doc) {
  const ul = doc.querySelector("ul.items-baseline");
  if (!ul) return "";
  let el = ul.previousElementSibling;
  while (el) {
    if (el.tagName && el.tagName.toLowerCase() === "p") {
      return el.textContent.trim();
    }
    el = el.previousElementSibling;
  }
  return "";
}

/**
 * Returns an array of { minutes, startPct, endPct, cadence|null }
 * extracted from a WhatsOnZwift workout DOM document.
 *
 * @param {Document} doc
 */
function extractWozSegmentsFromDoc(doc) {
  const container = doc.querySelector("div.order-2");
  if (!container) {
    console.warn("[zwo] WhatsOnZwift: order-2 container not found.");
    return [];
  }

  const bars = Array.from(container.querySelectorAll(".textbar"));
  const segments = [];

  for (const bar of bars) {
    const text = (bar.textContent || "").replace(/\s+/g, " ").trim();
    const powSpans = bar.querySelectorAll(
      'span[data-unit="relpow"][data-value]'
    );

    // Patterns like: "5x 4min @ 72% FTP, 2min @ 52% FTP"
    const repMatch = text.match(/(\d+)\s*x\b/i);
    if (repMatch && powSpans.length >= 2) {
      const reps = parseInt(repMatch[1], 10);
      if (Number.isFinite(reps) && reps > 0) {
        const durMatches = Array.from(
          text.matchAll(/(\d+(?:\.\d+)?)\s*(min|sec)/gi)
        );
        const durations = durMatches
          .map((m) => {
            const val = parseFloat(m[1]);
            const unit = (m[2] || "").toLowerCase();
            if (!Number.isFinite(val)) return null;
            if (unit === "sec") return val / 60;
            return val; // minutes
          })
          .filter((v) => v != null);

        if (durations.length >= 2) {
          const onMinutes = durations[0];
          const offMinutes = durations[1];

          const pOn = Number(powSpans[0].getAttribute("data-value"));
          const pOff = Number(powSpans[1].getAttribute("data-value"));

          if (
            Number.isFinite(onMinutes) &&
            onMinutes > 0 &&
            Number.isFinite(offMinutes) &&
            offMinutes > 0 &&
            Number.isFinite(pOn) &&
            Number.isFinite(pOff)
          ) {
            for (let i = 0; i < reps; i++) {
              segments.push({
                minutes: onMinutes,
                startPct: pOn,
                endPct: pOn,
                cadence: null,
              });
              segments.push({
                minutes: offMinutes,
                startPct: pOff,
                endPct: pOff,
                cadence: null,
              });
            }
            continue;
          }
        }
      }
    }

    // Single bars, including ramps, with minutes or seconds
    let minutes = null;
    const minMatch = text.match(/(\d+)\s*min/i);
    if (minMatch) {
      minutes = Number(minMatch[1]);
    } else {
      const secMatch = text.match(/(\d+)\s*sec/i);
      if (secMatch) {
        const secs = Number(secMatch[1]);
        if (Number.isFinite(secs)) {
          minutes = secs / 60;
        }
      }
    }
    if (!Number.isFinite(minutes) || minutes <= 0) continue;

    const cadenceMatch = text.match(/@\s*(\d+)\s*rpm/i);
    const cadence = cadenceMatch ? Number(cadenceMatch[1]) : null;

    if (powSpans.length === 1) {
      const pct = Number(powSpans[0].getAttribute("data-value"));
      if (!Number.isFinite(pct)) continue;
      segments.push({
        minutes,
        startPct: pct,
        endPct: pct,
        cadence,
      });
    } else if (powSpans.length >= 2) {
      const pctLow = Number(powSpans[0].getAttribute("data-value"));
      const pctHigh = Number(powSpans[1].getAttribute("data-value"));
      if (!Number.isFinite(pctLow) || !Number.isFinite(pctHigh)) continue;
      segments.push({
        minutes,
        startPct: pctLow,
        endPct: pctHigh,
        cadence,
      });
    }
  }

  return segments;
}

/**
 * Map WhatsOnZwift DOM segments into canonical [minutes, startPower, endPower].
 *
 * @param {Array<{minutes:number,startPct:number,endPct:number}>} segments
 * @returns {Array<[number, number, number]>}
 */
function canonicalizeWozSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];

  for (const s of segments) {
    if (!s || typeof s !== "object") continue;
    const minutes = Number(s.minutes);
    const start = Number(s.startPct);
    const end =
      s.endPct != null ? Number(s.endPct) : start;

    if (
      Number.isFinite(minutes) &&
      minutes > 0 &&
      Number.isFinite(start) &&
      Number.isFinite(end)
    ) {
      out.push([minutes, start, end]);
    }
  }

  return out;
}

/**
 * Core WhatsOnZwift canonical builder from a Document.
 *
 * @param {Document} doc
 * @param {string} sourceURL
 * @returns {[CanonicalWorkout|null, string|null]}
 */
function buildWhatsOnZwiftCanonicalFromDoc(doc, sourceURL) {
  const segments = extractWozSegmentsFromDoc(doc);
  const rawSegments = canonicalizeWozSegments(segments);

  if (!rawSegments.length) {
    return [
      null,
      "VeloDrive couldn’t find any intervals on this WhatsOnZwift workout page.",
    ];
  }

  const workoutTitle = extractWozTitleFromDoc(doc);
  const description = toPlainText(
    extractWozDescriptionFromDoc(doc) || ""
  );

  /** @type {CanonicalWorkout} */
  const cw = {
    source: "WhatsOnZwift",
    sourceURL,
    workoutTitle,
    rawSegments,
    description,
    filename: "",
  };

  return [cw, null];
}

/**
 * Parse the current WhatsOnZwift workout page into a CanonicalWorkout tuple.
 *
 * @returns {Promise<[CanonicalWorkout|null, string|null]>}
 */
export async function parseWhatsOnZwiftPage() {
  try {
    if (typeof window === "undefined") {
      return [
        null,
        "VeloDrive can only run on a WhatsOnZwift workout page in your browser.",
      ];
    }

    const path = window.location.pathname;
    if (!WHATSONZWIFT_WORKOUT_REGEX.test(path)) {
      return [
        null,
        "This doesn’t look like a WhatsOnZwift workout page. Open a workout on WhatsOnZwift and try again.",
      ];
    }

    return buildWhatsOnZwiftCanonicalFromDoc(document, window.location.href);
  } catch (err) {
    console.warn("[VeloDrive][WhatsOnZwift] parse error:", err);
    return [
      null,
      "VeloDrive couldn’t read this WhatsOnZwift workout. Try reloading the page and make sure the workout loads fully.",
    ];
  }
}

// ---------- URL-based import for TrainerDay / WhatsOnZwift ----------

/**
 * Import a workout from a URL (TrainerDay or WhatsOnZwift).
 *
 * @param {string} inputUrl
 * @returns {Promise<[CanonicalWorkout|null, string|null]>}
 */
export async function importWorkoutFromUrl(inputUrl) {
  let url;
  try {
    url = new URL(inputUrl);
  } catch {
    return [
      null,
      "That doesn’t look like a valid URL.",
    ];
  }

  const host = url.host.toLowerCase();

  if (host.includes("trainerroad.com")) {
    return [
      null,
      "TrainerRoad workouts can only be imported with the VeloDrive Chrome extension.",
    ];
  }

  if (host.includes("trainerday.com")) {
    return importTrainerDayFromUrl(url);
  }

  if (host.includes("whatsonzwift.com")) {
    return importWhatsOnZwiftFromUrl(url);
  }

  return [
    null,
    "This URL is not from a supported workout site (TrainerDay or WhatsOnZwift).",
  ];
}

/**
 * Import a WhatsOnZwift workout from a URL into a CanonicalWorkout.
 *
 * @param {URL} url
 * @returns {Promise<[CanonicalWorkout|null, string|null]>}
 */
async function importWhatsOnZwiftFromUrl(url) {
  try {
    const res = await fetch(url.toString(), {credentials: "omit"});
    if (!res.ok) {
      return [
        null,
        "VeloDrive couldn’t load this WhatsOnZwift workout. Try again later.",
      ];
    }

    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const [canonical, errMsg] = buildWhatsOnZwiftCanonicalFromDoc(
      doc,
      url.toString()
    );
    return [canonical, errMsg];
  } catch (err) {
    console.error("[zwo] WhatsOnZwift import error:", err);

    const isOnline =
      typeof navigator !== "undefined" &&
        navigator != null &&
        typeof navigator.onLine === "boolean"
        ? navigator.onLine
        : true;

    if (err instanceof TypeError && isOnline) {
      return [
        null,
        "VeloDrive couldn’t reach WhatsOnZwift from this page.\n\nIn Chrome, open chrome://extensions → VeloDrive → Details, then under “Site access” enable “Automatically allow access to these sites” for whatsonzwift.com, then try again.",
      ];
    }

    if (err instanceof TypeError && !isOnline) {
      return [
        null,
        "You appear to be offline. Check your connection and try again.",
      ];
    }

    return [
      null,
      "Import from WhatsOnZwift failed. See console for details.",
    ];
  }
}

