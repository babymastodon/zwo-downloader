(() => {
  if (window.__tr_json2zwo_initialized) return;
  window.__tr_json2zwo_initialized = true;

  const BASE_TRAINERROAD = "https://www.trainerroad.com";
  const TRAINERROAD_WORKOUT_REGEX = /\/app\/cycling\/workouts\/add\/(\d+)/;
  const TRAINERDAY_WORKOUT_REGEX = /^\/workouts\/([^/?#]+)/;

  // ---------- Helper: identify site ----------

  function getSiteType() {
    const host = location.host || "";
    if (host.includes("trainerroad.com")) return "trainerroad";
    if (host.includes("trainerday.com")) return "trainerday";
    return null;
  }

  // ---------- Fetch helpers ----------

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
        "trainerroad-jsonformat": "camel-case"
      }
    });
  }

  async function fetchTrainerDayWorkoutBySlug(slug) {
    const url = `https://app.api.trainerday.com/api/workouts/bySlug/${encodeURIComponent(
      slug
    )}`;
    // Public API – no credentials required
    return fetchJson(url, {credentials: "omit"});
  }

  // ---------- TrainerRoad helpers: CourseData -> samples ----------

  function getSeconds(pt) {
    if (typeof pt.Seconds === "number") return pt.Seconds;
    if (typeof pt.seconds === "number") return pt.seconds;
    if (typeof pt.time === "number") return pt.time;
    return 0;
  }

  function getFtpPercent(pt) {
    if (typeof pt.FtpPercent === "number") return pt.FtpPercent;
    if (typeof pt.ftpPercent === "number") return pt.ftpPercent;
    if (typeof pt.MemberFtpPercent === "number") return pt.MemberFtpPercent;
    if (typeof pt.memberFtpPercent === "number") return pt.memberFtpPercent;
    return 0;
  }

  function buildSamples(courseData) {
    const sorted = [...courseData].sort(
      (a, b) => getSeconds(a) - getSeconds(b)
    );
    const samples = [];
    for (const pt of sorted) {
      const t = getSeconds(pt) / 1000; // ms -> s
      const p = getFtpPercent(pt) / 100;
      if (!Number.isFinite(t)) continue;

      if (
        samples.length > 0 &&
        Math.abs(t - samples[samples.length - 1].t) < 1e-6
      ) {
        samples[samples.length - 1].p = p;
      } else {
        samples.push({t, p});
      }
    }
    return samples;
  }

  // ---------- Generic blocks (used by both sites) ----------

  function buildBlocksFromSamples(samples) {
    if (!samples || samples.length < 2) return [];

    const blocks = [];
    const EPS_POWER = 1e-4;
    const MIN_RAMP_DURATION_SEC = 1.0 + 1e-6;
    let carryToNext = 0;

    let i = 0;
    while (i < samples.length - 1) {
      let tStart = samples[i].t;
      let pStart = samples[i].p;

      let dt = samples[i + 1].t - samples[i].t;
      if (dt <= 0) {
        i++;
        continue;
      }

      let dp = samples[i + 1].p - samples[i].p;
      let baseKind;
      if (Math.abs(dp) <= EPS_POWER) baseKind = "steady";
      else if (dp > 0) baseKind = "rampUp";
      else baseKind = "rampDown";

      let j = i + 1;

      while (j < samples.length - 1) {
        const dt2 = samples[j + 1].t - samples[j].t;
        if (dt2 <= 0) {
          j++;
          continue;
        }
        const dp2 = samples[j + 1].p - samples[j].p;
        let kind2;
        if (Math.abs(dp2) <= EPS_POWER) kind2 = "steady";
        else if (dp2 > 0) kind2 = "rampUp";
        else kind2 = "rampDown";

        if (kind2 !== baseKind) break;
        j++;
      }

      const tEnd = samples[j].t;
      const pEnd = samples[j].p;
      let duration = tEnd - tStart;

      if (duration > 0) {
        if (baseKind !== "steady" && duration <= MIN_RAMP_DURATION_SEC) {
          carryToNext += duration;
        } else {
          duration += carryToNext;
          carryToNext = 0;

          if (baseKind === "steady") {
            blocks.push({
              kind: "steady",
              duration,
              power: pStart
            });
          } else if (baseKind === "rampUp") {
            blocks.push({
              kind: "rampUp",
              duration,
              powerLow: pStart,
              powerHigh: pEnd
            });
          } else if (baseKind === "rampDown") {
            blocks.push({
              kind: "rampDown",
              duration,
              powerLow: pStart,
              powerHigh: pEnd
            });
          }
        }
      }

      i = j;
    }

    if (carryToNext > 0 && blocks.length > 0) {
      blocks[blocks.length - 1].duration += carryToNext;
    }

    return blocks;
  }

  // TrainerDay: segments -> blocks
  function buildBlocksFromSegments(segments) {
    const blocks = [];
    if (!Array.isArray(segments)) return blocks;

    for (const seg of segments) {
      if (!Array.isArray(seg) || seg.length < 2) continue;
      const minutes = Number(seg[0]);
      const startPct = Number(seg[1]);
      const endPct =
        seg.length > 2 && seg[2] != null ? Number(seg[2]) : startPct;

      if (
        !Number.isFinite(minutes) ||
        !Number.isFinite(startPct) ||
        !Number.isFinite(endPct)
      ) {
        continue;
      }

      const duration = minutes * 60;
      const pStart = startPct / 100;
      const pEnd = endPct / 100;

      if (duration <= 0) continue;

      if (Math.abs(pStart - pEnd) < 1e-6) {
        blocks.push({
          kind: "steady",
          duration,
          power: pStart
        });
      } else if (pEnd > pStart) {
        blocks.push({
          kind: "rampUp",
          duration,
          powerLow: pStart,
          powerHigh: pEnd
        });
      } else {
        blocks.push({
          kind: "rampDown",
          duration,
          powerLow: pStart,
          powerHigh: pEnd
        });
      }
    }

    return blocks;
  }

  function almostEqual(a, b, tol) {
    return Math.abs(a - b) <= tol;
  }

  function blocksSimilar(a, b, durTolSec, powTol) {
    if (a.kind !== b.kind) return false;
    if (!almostEqual(a.duration, b.duration, durTolSec)) return false;
    if (a.kind === "steady") {
      return almostEqual(a.power, b.power, powTol);
    }
    if (a.kind === "rampUp" || a.kind === "rampDown") {
      return (
        almostEqual(a.powerLow, b.powerLow, powTol) &&
        almostEqual(a.powerHigh, b.powerHigh, powTol)
      );
    }
    return false;
  }

  function compressToXmlBlocks(blocks) {
    const xmlBlocks = [];
    const DUR_TOL = 1;
    const PWR_TOL = 0.01;

    let i = 0;
    while (i < blocks.length) {
      // Try to detect IntervalsT: [on, off] repeated >= 2 times
      if (i + 3 < blocks.length) {
        const on1 = blocks[i];
        const off1 = blocks[i + 1];

        if (off1.kind === "steady") {
          let repeat = 1;
          let j = i + 2;

          while (j + 1 < blocks.length) {
            const onNext = blocks[j];
            const offNext = blocks[j + 1];
            if (
              !blocksSimilar(on1, onNext, DUR_TOL, PWR_TOL) ||
              !blocksSimilar(off1, offNext, DUR_TOL, PWR_TOL)
            ) {
              break;
            }
            repeat++;
            j += 2;
          }

          if (repeat >= 2) {
            const onDur = Math.round(on1.duration);
            const offDur = Math.round(off1.duration);
            const offPower = off1.power;

            let xmlBlock;
            if (on1.kind === "steady") {
              xmlBlock = {
                type: "IntervalsT",
                attrs: {
                  Repeat: String(repeat),
                  OnDuration: String(onDur),
                  OffDuration: String(offDur),
                  PowerOnLow: on1.power.toFixed(3),
                  PowerOnHigh: on1.power.toFixed(3),
                  PowerOff: offPower.toFixed(3)
                }
              };
            } else if (on1.kind === "rampUp") {
              xmlBlock = {
                type: "IntervalsT",
                attrs: {
                  Repeat: String(repeat),
                  OnDuration: String(onDur),
                  OffDuration: String(offDur),
                  PowerOnLow: on1.powerLow.toFixed(3),
                  PowerOnHigh: on1.powerHigh.toFixed(3),
                  PowerOff: offPower.toFixed(3)
                }
              };
            } else if (on1.kind === "rampDown") {
              xmlBlock = {
                type: "IntervalsT",
                attrs: {
                  Repeat: String(repeat),
                  OnDuration: String(onDur),
                  OffDuration: String(offDur),
                  PowerOnLow: on1.powerLow.toFixed(3),
                  PowerOnHigh: on1.powerHigh.toFixed(3),
                  PowerOff: offPower.toFixed(3)
                }
              };
            }

            xmlBlocks.push(xmlBlock);
            i += repeat * 2;
            continue;
          }
        }
      }

      const b = blocks[i];
      if (b.kind === "steady") {
        xmlBlocks.push({
          type: "SteadyState",
          attrs: {
            Duration: String(Math.round(b.duration)),
            Power: b.power.toFixed(3)
          }
        });
      } else if (b.kind === "rampUp") {
        xmlBlocks.push({
          type: "Warmup",
          attrs: {
            Duration: String(Math.round(b.duration)),
            PowerLow: b.powerLow.toFixed(3),
            PowerHigh: b.powerHigh.toFixed(3)
          }
        });
      } else if (b.kind === "rampDown") {
        xmlBlocks.push({
          type: "Cooldown",
          attrs: {
            Duration: String(Math.round(b.duration)),
            PowerLow: b.powerLow.toFixed(3),
            PowerHigh: b.powerHigh.toFixed(3)
          }
        });
      }
      i++;
    }

    return xmlBlocks;
  }

  // ---------- Metadata / ZWO generation ----------

  function cdataWrap(str) {
    if (!str) return "<![CDATA[]]>";
    const safe = String(str).replace("]]>", "]]&gt;");
    return `<![CDATA[${safe}]]>`;
  }

  function buildMetaFromTrainerRoad(summary, url) {
    const s = summary || {};
    let category = "Uncategorized";

    if (
      s.progression &&
      s.progression.text &&
      typeof s.progressionLevel === "number"
    ) {
      category = `${s.progression.text} ${s.progressionLevel.toFixed(2)}`;
    } else if (s.progression && s.progression.text) {
      category = s.progression.text;
    }

    const name =
      s.workoutName ||
      (s.id != null ? `TrainerRoad Workout ${s.id}` : "TrainerRoad Workout");

    const tss = typeof s.tss === "number" ? s.tss : null;
    const kj = typeof s.kj === "number" ? s.kj : null;
    const intensityFactorRaw =
      typeof s.intensityFactor === "number" ? s.intensityFactor : null;
    const intensityFactor =
      intensityFactorRaw != null
        ? intensityFactorRaw > 1
          ? intensityFactorRaw / 100
          : intensityFactorRaw
        : null;

    let description =
      s.workoutDescription || s.goalDescription || "Converted from TrainerRoad.";

    return {
      source: "TrainerRoad",
      name,
      description,
      category,
      tss,
      kj,
      ifValue: intensityFactor,
      url
    };
  }

  function computeKjFromTrainerDaySegments(segments, ftpWatts = 250) {
    if (!Array.isArray(segments)) return null;
    let totalKj = 0;

    for (const seg of segments) {
      if (!Array.isArray(seg) || seg.length < 2) continue;
      const minutes = Number(seg[0]);
      const startPct = Number(seg[1]);
      const endPct =
        seg.length > 2 && seg[2] != null ? Number(seg[2]) : startPct;
      if (
        !Number.isFinite(minutes) ||
        !Number.isFinite(startPct) ||
        !Number.isFinite(endPct)
      ) {
        continue;
      }
      const durSec = minutes * 60;
      const avgPct = (startPct + endPct) / 2;
      const watts = ftpWatts * (avgPct / 100);
      const kJ = (watts * durSec) / 1000;
      totalKj += kJ;
    }

    return Math.round(totalKj);
  }

  function buildMetaFromTrainerDay(details, url) {
    const d = details || {};
    const title =
      d.title || document.title || "TrainerDay Workout";

    const description = d.description || "";

    const category = d.dominantZone || "Uncategorized";

    const tss =
      typeof d.bikeStress === "number" ? d.bikeStress : null;

    const ifValue =
      typeof d.intensity === "number" ? d.intensity : null;

    const segments =
      Array.isArray(d.segments) ? d.segments : null;

    const kj = computeKjFromTrainerDaySegments(segments, 250);

    return {
      source: "TrainerDay",
      name: title,
      description: description || "Converted from TrainerDay.",
      category,
      tss,
      kj,
      ifValue,
      url
    };
  }

  function toZwoXmlFromBlocksAndMeta(blocks, meta) {
    const xmlBlocks = compressToXmlBlocks(blocks);

    const source = meta.source || "Unknown";
    const name = meta.name || "Workout";
    const category = meta.category || "Uncategorized";
    let description = meta.description || "";

    const tss = meta.tss;
    const kj = meta.kj;
    const ifValue = meta.ifValue;
    const url = meta.url;

    // Total workout duration from all blocks
    const totalDurationSec = blocks.reduce(
      (sum, b) => sum + (Number(b.duration) || 0),
      0
    );
    const durationMinutes =
      totalDurationSec > 0 ? Math.round(totalDurationSec / 60) : null;

    const metrics = [];
    if (typeof tss === "number") metrics.push(`TSS: ${tss}`);
    if (typeof kj === "number") metrics.push(`kJ: ${kj}`);
    if (typeof ifValue === "number") metrics.push(`IF: ${ifValue.toFixed(2)}`);
    if (durationMinutes != null)
      metrics.push(`Duration: ${durationMinutes} min`);

    if (metrics.length > 0) {
      description +=
        (description ? "\n\n" : "") + `Metrics: ${metrics.join(", ")}`;
    }

    const tags = [];
    tags.push({name: source});
    tags.push({name: category});
    if (typeof tss === "number") tags.push({name: `TSS ${tss}`});
    if (typeof kj === "number") tags.push({name: `kJ ${kj}`});
    if (typeof ifValue === "number")
      tags.push({name: `IF ${ifValue.toFixed(2)}`});
    if (durationMinutes != null)
      tags.push({name: `Duration:${durationMinutes}min`});
    if (url) tags.push({name: `URL:${url}`});

    const blocksXml = xmlBlocks
      .map((b) => {
        const attrs = Object.entries(b.attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(" ");
        return `    <${b.type} ${attrs} />`;
      })
      .join("\n");

    const tagsXml = tags.map((t) => `  <tag name="${t.name}"/>`).join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workout_file>
  <author>${source} json2zwo</author>
  <name>${name}</name>
  <description>${cdataWrap(description)}</description>
  <category>${category}</category>
  <sportType>bike</sportType>
  <tags>
${tagsXml}
  </tags>
  <workout>
${blocksXml}
  </workout>
</workout_file>`;

    return xml;
  }

  // ---------- Download helper ----------

  function downloadZwo(zwoXml, filename) {
    const blob = new Blob([zwoXml], {type: "application/xml"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- Site-specific generators ----------

  async function generateTrainerRoadZwo(shouldDownload) {
    const match = window.location.pathname.match(TRAINERROAD_WORKOUT_REGEX);
    if (!match) {
      console.error("[TR2ZWO] [TrainerRoad] Not on a workout add page.");
      return;
    }
    const workoutId = match[1];

    try {
      const chartUrl = `${BASE_TRAINERROAD}/app/api/workouts/${workoutId}/chart-data`;
      const summaryUrl = `${BASE_TRAINERROAD}/app/api/workouts/${workoutId}/summary?withDifficultyRating=true`;

      console.log("[TR2ZWO] [TrainerRoad] Fetching chart data:", chartUrl);
      const chartData = await fetchTrainerRoadJson(chartUrl);

      console.log("[TR2ZWO] [TrainerRoad] Fetching metadata:", summaryUrl);
      const metaResp = await fetchTrainerRoadJson(summaryUrl);
      const summary = metaResp.summary || metaResp;

      let courseData =
        chartData.CourseData || chartData.courseData || chartData;

      if (!Array.isArray(courseData) && chartData.courseData) {
        courseData = chartData.courseData;
      }
      if (!Array.isArray(courseData) && chartData.data) {
        courseData = chartData.data;
      }

      if (!Array.isArray(courseData) || courseData.length === 0) {
        console.error(
          "[TR2ZWO] [TrainerRoad] No CourseData array found in chart response.",
          chartData
        );
        return;
      }

      const samples = buildSamples(courseData);
      const blocks = buildBlocksFromSamples(samples);
      const meta = buildMetaFromTrainerRoad(summary, window.location.href);

      const zwoXml = toZwoXmlFromBlocksAndMeta(blocks, meta);
      const baseName = meta.name || "Workout";
      const safeBase = baseName.replace(/[^\w\-]+/g, "_");
      const filename = `${safeBase}.zwo`;

      console.log("===== TrainerRoad → ZWO XML =====");
      console.log(zwoXml);
      console.log("===== End ZWO XML =====");

      if (shouldDownload) {
        downloadZwo(zwoXml, filename);
      }
    } catch (err) {
      console.error("[TR2ZWO] [TrainerRoad] Error building ZWO:", err);
    }
  }

  async function generateTrainerDayZwo(shouldDownload) {
    const path = window.location.pathname;
    const match = path.match(TRAINERDAY_WORKOUT_REGEX);
    if (!match) {
      console.error("[TR2ZWO] [TrainerDay] Not on a workout page.");
      return;
    }
    const slug = match[1];

    try {
      const url = window.location.href;
      console.log(
        "[TR2ZWO] [TrainerDay] Fetching workout by slug:",
        slug
      );
      const details = await fetchTrainerDayWorkoutBySlug(slug);

      const segments =
        Array.isArray(details.segments) ? details.segments : null;

      if (!segments || segments.length === 0) {
        console.error(
          "[TR2ZWO] [TrainerDay] No segments in workout data:",
          details
        );
        return;
      }

      const blocks = buildBlocksFromSegments(segments);
      const meta = buildMetaFromTrainerDay(details, url);

      const zwoXml = toZwoXmlFromBlocksAndMeta(blocks, meta);
      const baseName = meta.name || "Workout";
      const safeBase = baseName.replace(/[^\w\-]+/g, "_");
      const filename = `${safeBase}.zwo`;

      console.log("===== TrainerDay → ZWO XML =====");
      console.log(zwoXml);
      console.log("===== End ZWO XML =====");

      if (shouldDownload) {
        downloadZwo(zwoXml, filename);
      }
    } catch (err) {
      console.error("[TR2ZWO] [TrainerDay] Error building ZWO:", err);
    }
  }

  // ---------- Main dispatcher ----------

  function generateZwoForCurrentPage(shouldDownload) {
    const site = getSiteType();
    if (site === "trainerroad") {
      generateTrainerRoadZwo(shouldDownload);
    } else if (site === "trainerday") {
      generateTrainerDayZwo(shouldDownload);
    } else {
      console.error("[TR2ZWO] Unsupported site:", location.host);
    }
  }

  // Expose a manual trigger for downloading from DevTools:
  window.tr2zwoDownload = function () {
    generateZwoForCurrentPage(true);
  };

  // Listen for messages from background.js (toolbar icon click)
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
      if (msg && msg.type === "TR2ZWO_DOWNLOAD") {
        generateZwoForCurrentPage(true);
      }
    });
  }
})();

