// content.js

(() => {
  const TRAINERROAD_WORKOUT_REGEX =
    /\/app\/cycling\/workouts\/add\/(\d+)(?:\/|$)/;
  const TRAINERDAY_WORKOUT_REGEX = /^\/workouts\/([^/?#]+)/;
  const WHATSONZWIFT_WORKOUT_REGEX = /^\/workouts\/.+/;

  // ---------------- Site detection ----------------

  function getSiteType() {
    const host = location.host || "";
    if (host.includes("trainerroad.com")) return "trainerroad";
    if (host.includes("trainerday.com")) return "trainerday";
    if (host.includes("whatsonzwift.com")) return "whatsonzwift";
    return null;
  }

  // ---------------- Fetch helpers ----------------

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return res.json();
  }

  async function fetchTrainerRoadJson(url) {
    return fetchJson(url, {
      credentials: "include",
      headers: {
        "trainerroad-jsonformat": "camel-case",
      },
    });
  }

  async function fetchTrainerDayWorkoutBySlug(slug) {
    const url = `https://app.api.trainerday.com/api/workouts/bySlug/${encodeURIComponent(
      slug
    )}`;
    return fetchJson(url, {credentials: "omit"});
  }

  // ---------------- TrainerRoad scrape ----------------

  async function scrapeTrainerRoad() {
    const match = window.location.pathname.match(TRAINERROAD_WORKOUT_REGEX);
    if (!match) {
      return {
        success: false,
        source: "TrainerRoad",
        sourceURL: window.location.href,
        workoutTitle: "",
        rawSegments: [],
        description: "",
        error: "Not on a TrainerRoad workout page.",
      };
    }

    const workoutId = match[1];
    const baseUrl = "https://www.trainerroad.com";

    try {
      const chartUrl = `${baseUrl}/app/api/workouts/${workoutId}/chart-data`;
      const summaryUrl = `${baseUrl}/app/api/workouts/${workoutId}/summary?withDifficultyRating=true`;

      const chartData = await fetchTrainerRoadJson(chartUrl);
      const metaResp = await fetchTrainerRoadJson(summaryUrl);
      const summary = metaResp.summary || metaResp || {};

      // Course data is left as-is as the "raw segments"
      let courseData =
        chartData.CourseData || chartData.courseData || chartData;
      if (!Array.isArray(courseData) && chartData.courseData) {
        courseData = chartData.courseData;
      }
      if (!Array.isArray(courseData) && chartData.data) {
        courseData = chartData.data;
      }

      const rawSegments = Array.isArray(courseData) ? courseData : [];

      const workoutTitle =
        summary.workoutName || document.title || "TrainerRoad Workout";

      // Original description from TrainerRoad
      const description =
        summary.workoutDescription || summary.goalDescription || "";

      const success = !!workoutTitle && rawSegments.length > 0;

      return {
        success,
        source: "TrainerRoad",
        sourceURL: window.location.href,
        workoutTitle,
        rawSegments,
        description,
      };
    } catch (err) {
      console.warn("[VeloDrive][TrainerRoad] scrape error:", err);
      return {
        success: false,
        source: "TrainerRoad",
        sourceURL: window.location.href,
        workoutTitle: "",
        rawSegments: [],
        description: "",
        error: String(err && err.message ? err.message : err),
      };
    }
  }

  // ---------------- TrainerDay scrape ----------------

  async function scrapeTrainerDay() {
    const path = window.location.pathname;
    const match = path.match(TRAINERDAY_WORKOUT_REGEX);
    if (!match) {
      return {
        success: false,
        source: "TrainerDay",
        sourceURL: window.location.href,
        workoutTitle: "",
        rawSegments: [],
        description: "",
        error: "Not on a TrainerDay workout page.",
      };
    }

    const slug = match[1];

    try {
      const details = await fetchTrainerDayWorkoutBySlug(slug);

      const rawSegments = Array.isArray(details.segments)
        ? details.segments
        : [];

      const workoutTitle =
        details.title || document.title || "TrainerDay Workout";

      const description = details.description || "";

      const success = !!workoutTitle && rawSegments.length > 0;

      return {
        success,
        source: "TrainerDay",
        sourceURL: window.location.href,
        workoutTitle,
        rawSegments,
        description,
      };
    } catch (err) {
      console.warn("[VeloDrive][TrainerDay] scrape error:", err);
      return {
        success: false,
        source: "TrainerDay",
        sourceURL: window.location.href,
        workoutTitle: "",
        rawSegments: [],
        description: "",
        error: String(err && err.message ? err.message : err),
      };
    }
  }

  // ---------------- WhatsOnZwift helpers + scrape ----------------

  function extractWozTitle() {
    const el = document.querySelector("header.my-8 h1");
    return el ? el.textContent.trim() : "WhatsOnZwift Workout";
  }

  function extractWozDescription() {
    const ul = document.querySelector("ul.items-baseline");
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

  // Return an array of { minutes, startPct, endPct, cadence }
  function extractWozSegmentsFromDom() {
    const container = document.querySelector("div.order-2");
    if (!container) {
      console.warn("[VeloDrive][WhatsOnZwift] order-2 container not found.");
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

  async function scrapeWhatsOnZwift() {
    const path = window.location.pathname;
    if (!WHATSONZWIFT_WORKOUT_REGEX.test(path)) {
      return {
        success: false,
        source: "WhatsOnZwift",
        sourceURL: window.location.href,
        workoutTitle: "",
        rawSegments: [],
        description: "",
        error: "Not on a WhatsOnZwift workout page.",
      };
    }

    try {
      const segments = extractWozSegmentsFromDom();

      const rawSegments = segments;

      const workoutTitle = extractWozTitle();
      const description = extractWozDescription() || "";

      const success = !!workoutTitle && rawSegments.length > 0;

      return {
        success,
        source: "WhatsOnZwift",
        sourceURL: window.location.href,
        workoutTitle,
        rawSegments,
        description,
      };
    } catch (err) {
      console.warn("[VeloDrive][WhatsOnZwift] scrape error:", err);
      return {
        success: false,
        source: "WhatsOnZwift",
        sourceURL: window.location.href,
        workoutTitle: "",
        rawSegments: [],
        description: "",
        error: String(err && err.message ? err.message : err),
      };
    }
  }

  // ---------------- Main scrape dispatcher ----------------

  async function handleScrapeRequest() {
    const site = getSiteType();
    let result = {
      success: false,
      source: site || "Unknown",
      sourceURL: window.location.href,
      workoutTitle: "",
      rawSegments: [],
      description: "",
      error: "",
    };

    try {
      if (site === "trainerroad") {
        result = await scrapeTrainerRoad();
      } else if (site === "trainerday") {
        result = await scrapeTrainerDay();
      } else if (site === "whatsonzwift") {
        result = await scrapeWhatsOnZwift();
      } else {
        result.error = "Unsupported site.";
      }
    } catch (err) {
      result.error = String(err && err.message ? err.message : err);
    }

    // Send result to background.js for persistence + follow-up behavior
    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: "VD_SCRAPE_RESULT",
        payload: result,
      });
    }
  }

  // ---------------- Message handling ----------------

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "VD_SCRAPE_WORKOUT") {
        handleScrapeRequest();
        return;
      }

      if (msg.type === "VD_SCRAPE_FAILED_PROMPT") {
        const {error, source} = msg;
        let text = "VeloDrive could not scrape this workout.";
        if (source) {
          text = `VeloDrive could not scrape this workout from ${source}.`;
        }
        if (error) {
          text += `\n\nError: ${error}`;
        }
        text += "\n\nDo you still want to open VeloDrive?";

        let openOptions = true;
        try {
          openOptions = window.confirm(text);
        } catch {
          // If confirm fails for some reason, default to opening.
          openOptions = true;
        }

        _sendResponse({openOptions});
        return true; // indicate we used sendResponse
      }
    });
  }
})();

