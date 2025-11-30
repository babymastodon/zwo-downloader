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

// ---------------- Parsers for each site -> CanonicalWorkout -----------
//
// Each parser returns a tuple: [CanonicalWorkout|null, string|null]
//   - On success: [canonicalWorkout, null]
//   - On failure: [null, "user-friendly error message"]

// ---------- TrainerRoad ----------

/**
 * Convert TrainerRoad chart "course data" into canonical [minutes, startPower, endPower].
 *
 * Input `seconds` is actually milliseconds. There is one row per second.
 *
 * Output:
 *  - First return value: Array of [minutes, ftpPercentBegin, ftpPercentEnd]
 *  - Second return value: user-friendly error string or null if successful
 *
 * The function:
 *  - Validates and sorts the input by `seconds`
 *  - Ensures samples are 1 second (1000 ms) apart
 *  - Collapses 1-second samples into multi-second segments
 *    where the power changes linearly with a *constant* per-second delta
 *    (i.e. flat, steady slope up, or steady slope down).
 *
 * @param {Array<{seconds: number, ftpPercent: number}>} courseData
 * @returns {[Array<[number, number, number]>, (string|null)]}
 */
function canonicalizeTrainerRoadSegments(courseData) {
  const errorPrefix = "Invalid courseData: ";

  // Basic shape check
  if (!Array.isArray(courseData)) {
    return [[], errorPrefix + "must be an array"];
  }
  if (courseData.length === 0) {
    return [[], errorPrefix + "array is empty"];
  }

  // Defensive copy & sort by time, in case it's not sorted
  const data = courseData.slice().sort((a, b) => a.seconds - b.seconds);

  // Validate rows and timing (1 Hz, seconds actually milliseconds)
  for (let i = 0; i < data.length; i++) {
    const row = data[i];

    if (
      !row ||
      typeof row.seconds !== "number" ||
      typeof row.ftpPercent !== "number" ||
      !Number.isFinite(row.seconds) ||
      !Number.isFinite(row.ftpPercent)
    ) {
      return [[], errorPrefix + `row ${i} must have numeric 'seconds' and 'ftpPercent'`];
    }

    if (i > 0) {
      const prev = data[i - 1];
      const dtMs = row.seconds - prev.seconds;

      if (dtMs <= 0) {
        return [[], errorPrefix + `'seconds' must be strictly increasing (problem at index ${i})`];
      }

      // Expect 1 second spacing -> 1000 ms.
      // Allow tiny numerical jitter, but be pretty strict.
      const expectedMs = 1000;
      if (Math.abs(dtMs - expectedMs) > 1e-3) {
        return [
          [],
          errorPrefix +
          `expected 1-second (1000 ms) spacing but found ${dtMs} ms between index ${i - 1} and ${i}`,
        ];
      }
    }
  }

  const segments = [];
  const EPS = 1e-9;
  const almostEqual = (a, b) => Math.abs(a - b) <= EPS;

  const n = data.length;

  // Single-point workout: treat as a 1-second flat segment
  if (n === 1) {
    const seconds = 1;
    const minutes = seconds / 60;
    const p = data[0].ftpPercent;
    segments.push([minutes, p, p]);
    return [segments, null];
  }

  let segmentStartIndex = 0;
  let prevDiff = null;

  // Walk through and group by constant per-second delta of ftpPercent
  for (let i = 1; i < n; i++) {
    const currDiff = data[i].ftpPercent - data[i - 1].ftpPercent;

    if (prevDiff === null) {
      // First delta
      prevDiff = currDiff;
      continue;
    }

    // If the delta changes, we close the previous segment at i - 1
    if (!almostEqual(currDiff, prevDiff)) {
      const endIndex = i - 1;
      const seconds = endIndex - segmentStartIndex + 1; // one row per second
      const minutes = seconds / 60;
      const startPower = data[segmentStartIndex].ftpPercent;
      const endPower = data[endIndex].ftpPercent;

      segments.push([minutes, startPower, endPower]);

      // New segment starts at the current row i
      segmentStartIndex = i;
      prevDiff = currDiff;
    }
  }

  // Flush the final segment
  {
    const endIndex = n - 1;
    const seconds = endIndex - segmentStartIndex + 1;
    const minutes = seconds / 60;
    const startPower = data[segmentStartIndex].ftpPercent;
    const endPower = data[endIndex].ftpPercent;

    segments.push([minutes, startPower, endPower]);
  }

  return [segments, null];
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

    const description =
      summary.workoutDescription ||
      summary.goalDescription ||
      "";

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
 * Parse the current TrainerDay workout page into a CanonicalWorkout tuple.
 *
 * @returns {Promise<[CanonicalWorkout|null, string|null]>}
 */
export async function parseTrainerDayPage() {
  try {
    const path = window.location.pathname;
    const match = path.match(TRAINERDAY_WORKOUT_REGEX);
    if (!match) {
      return [
        null,
        "This doesn’t look like a TrainerDay workout page. Open a workout on TrainerDay and try again.",
      ];
    }

    const slug = match[1];
    const details = await fetchTrainerDayWorkoutBySlug(slug);

    const rawSegments = canonicalizeTrainerDaySegments(
      Array.isArray(details.segments) ? details.segments : []
    );

    if (!rawSegments.length) {
      return [
        null,
        "This TrainerDay workout doesn’t have any intervals that VeloDrive can use.",
      ];
    }

    const workoutTitle =
      details.title || document.title || "TrainerDay Workout";
    const description = details.description || "";

    /** @type {CanonicalWorkout} */
    const cw = {
      source: "TrainerDay",
      sourceURL: window.location.href,
      workoutTitle,
      rawSegments,
      description,
      filename: "",
    };

    return [cw, null];
  } catch (err) {
    console.warn("[VeloDrive][TrainerDay] parse error:", err);
    return [
      null,
      "VeloDrive couldn’t import this TrainerDay workout. Please check the URL and try again.",
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

// Convenience wrappers that use the current page DOM
function extractWozTitle() {
  return extractWozTitleFromDoc(document);
}

function extractWozDescription() {
  return extractWozDescriptionFromDoc(document);
}

function extractWozSegmentsFromDom() {
  return extractWozSegmentsFromDoc(document);
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
 * Parse the current WhatsOnZwift workout page into a CanonicalWorkout tuple.
 *
 * @returns {Promise<[CanonicalWorkout|null, string|null]>}
 */
export async function parseWhatsOnZwiftPage() {
  try {
    const path = window.location.pathname;
    if (!WHATSONZWIFT_WORKOUT_REGEX.test(path)) {
      return [
        null,
        "This doesn’t look like a WhatsOnZwift workout page. Open a workout on WhatsOnZwift and try again.",
      ];
    }

    const segments = extractWozSegmentsFromDom();
    const rawSegments = canonicalizeWozSegments(segments);

    if (!rawSegments.length) {
      return [
        null,
        "VeloDrive couldn’t find any intervals on this WhatsOnZwift workout page.",
      ];
    }

    const workoutTitle = extractWozTitle();
    const description = extractWozDescription() || "";

    /** @type {CanonicalWorkout} */
    const cw = {
      source: "WhatsOnZwift",
      sourceURL: window.location.href,
      workoutTitle,
      rawSegments,
      description,
      filename: "",
    };

    return [cw, null];
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
 * @returns {Promise<{
 *   canonical: CanonicalWorkout|null,
 *   error: {type:string,message:string}|null
 * }>}
 */
export async function importWorkoutFromUrl(inputUrl) {
  let url;
  try {
    url = new URL(inputUrl);
  } catch {
    return {
      canonical: null,
      error: {
        type: "invalidUrl",
        message: "That doesn’t look like a valid URL.",
      },
    };
  }

  const host = url.host.toLowerCase();

  if (host.includes("trainerday.com")) {
    return importTrainerDayFromUrl(url);
  }

  if (host.includes("whatsonzwift.com")) {
    return importWhatsOnZwiftFromUrl(url);
  }

  return {
    canonical: null,
    error: {
      type: "unsupportedHost",
      message:
        "This URL is not from a supported workout site (TrainerDay or WhatsOnZwift).",
    },
  };
}

async function importTrainerDayFromUrl(url) {
  try {
    const match = url.pathname.match(TRAINERDAY_WORKOUT_REGEX);
    if (!match) {
      return {
        canonical: null,
        error: {
          type: "invalidTrainerDayPath",
          message: "This TrainerDay URL does not look like a workout page.",
        },
      };
    }

    const slug = match[1];
    const details = await fetchTrainerDayWorkoutBySlug(slug);

    const rawSegments = canonicalizeTrainerDaySegments(
      Array.isArray(details.segments) ? details.segments : []
    );

    if (!rawSegments.length) {
      return {
        canonical: null,
        error: {
          type: "noSegments",
          message: "TrainerDay workout has no segments to import.",
        },
      };
    }

    /** @type {CanonicalWorkout} */
    const canonical = {
      source: "TrainerDay",
      sourceURL: url.toString(),
      workoutTitle: details.title || "TrainerDay Workout",
      rawSegments,
      description: details.description || "",
      filename: "",
    };

    return {canonical, error: null};
  } catch (err) {
    console.error("[zwo] TrainerDay import error:", err);

    if (err && (err.isCorsError)) {
      return {
        canonical: null,
        error: {
          type: "corsOrPermission",
          message:
            "VeloDrive couldn’t reach TrainerDay from this page.\n\n" +
            "In Chrome, open chrome://extensions → VeloDrive → Details, then under “Site access” enable “Automatically allow access to these sites” for trainerday.com and app.api.trainerday.com, then try again.",
        },
      };
    }

    return {
      canonical: null,
      error: {
        type: "exception",
        message: "Import from TrainerDay failed. See console for details.",
      },
    };
  }
}

async function importWhatsOnZwiftFromUrl(url) {
  try {
    const res = await fetch(url.toString(), {credentials: "omit"});
    if (!res.ok) {
      return {
        canonical: null,
        error: {
          type: "network",
          message: `WhatsOnZwift request failed (HTTP ${res.status}).`,
        },
      };
    }

    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const wozSegments = extractWozSegmentsFromDoc(doc);
    if (!wozSegments || !wozSegments.length) {
      console.warn("[zwo][WhatsOnZwift] No segments extracted from DOM.");
      return {
        canonical: null,
        error: {
          type: "noSegments",
          message:
            "Could not find any intervals on this WhatsOnZwift workout page.",
        },
      };
    }

    const rawSegments = canonicalizeWozSegments(wozSegments);
    if (!rawSegments.length) {
      return {
        canonical: null,
        error: {
          type: "noSegments",
          message:
            "WhatsOnZwift workout intervals could not be canonicalized.",
        },
      };
    }

    const workoutTitle = extractWozTitleFromDoc(doc);
    const description = extractWozDescriptionFromDoc(doc);

    /** @type {CanonicalWorkout} */
    const canonical = {
      source: "WhatsOnZwift",
      sourceURL: url.toString(),
      workoutTitle,
      rawSegments,
      description: description || "",
      filename: "",
    };

    return {canonical, error: null};
  } catch (err) {
    console.error("[zwo] WhatsOnZwift import error:", err);

    const isOnline =
      typeof navigator !== "undefined" &&
        navigator != null &&
        typeof navigator.onLine === "boolean"
        ? navigator.onLine
        : true;

    if (err instanceof TypeError && isOnline) {
      return {
        canonical: null,
        error: {
          type: "corsOrPermission",
          message:
            "VeloDrive couldn’t reach WhatsOnZwift from this page.\n\n" +
            "In Chrome, open chrome://extensions → VeloDrive → Details, then under “Site access” enable “Automatically allow access to these sites” for whatsonzwift.com, then try again.",
        },
      };
    }

    return {
      canonical: null,
      error: {
        type: "exception",
        message:
          "Import from WhatsOnZwift failed. See console for details.",
      },
    };
  }
}

