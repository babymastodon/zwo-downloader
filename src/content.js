(() => {
  if (window.__tr_json2zwo_initialized) return;
  window.__tr_json2zwo_initialized = true;

  const BASE_TRAINERROAD = "https://www.trainerroad.com";
  const TRAINERROAD_WORKOUT_REGEX =
    /\/app\/cycling\/workouts\/add\/(\d+)(?:\/|$)/;
  const TRAINERDAY_WORKOUT_REGEX = /^\/workouts\/([^/?#]+)/;
  const WHATSONZWIFT_WORKOUT_REGEX = /^\/workouts\/.+/;
  const DEFAULT_FTP = 250;

  // ---------- Helper: identify site ----------

  function getSiteType() {
    const host = location.host || "";
    if (host.includes("trainerroad.com")) return "trainerroad";
    if (host.includes("trainerday.com")) return "trainerday";
    if (host.includes("whatsonzwift.com")) return "whatsonzwift";
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
    return fetchJson(url, {credentials: "omit"});
  }

  // ---------- TrainerRoad helpers: CourseData -> samples ----------

  function getSeconds(pt) {
    if (typeof pt.Seconds === "number") return pt.Seconds;
    if (typeof pt.seconds === "number") return pt.seconds;
    if (typeof pt.time === "number") return pt.time;
    return 0;
  }

  // IMPORTANT: never use MemberFtpPercent here; only the relative ftpPercent
  function getFtpPercent(pt) {
    if (typeof pt.FtpPercent === "number") return pt.FtpPercent;
    if (typeof pt.ftpPercent === "number") return pt.ftpPercent;
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

  // ---------- Generic blocks (used by all sites for ZWO) ----------

  // Blocks are:
  // { kind: "steady", duration, power, cadence? }
  // { kind: "rampUp"|"rampDown", duration, powerLow, powerHigh, cadence? }

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

  // TrainerDay + generic segments (no cadence) -> blocks
  // segments: [minutes, startPct, endPct?]
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

  // ZWO IntervalsT per spec:
  // <IntervalsT Repeat="N" OnDuration="sec" OffDuration="sec"
  //             OnPower="0.xx" OffPower="0.yy"
  //             [Cadence=".."] [CadenceResting=".."] ... />
  // Warmup/Cooldown: Duration + PowerLow/PowerHigh (+ optional Cadence).
  // SteadyState: Duration + Power (+ optional Cadence).
  function compressToXmlBlocks(blocks) {
    const xmlBlocks = [];
    const DUR_TOL = 1;
    const PWR_TOL = 0.01;

    let i = 0;
    while (i < blocks.length) {
      // Detect repeated steady on/off pairs → IntervalsT
      if (i + 3 < blocks.length) {
        const firstA = blocks[i];
        const firstB = blocks[i + 1];

        if (firstA.kind === "steady" && firstB.kind === "steady") {
          let repeat = 1;
          let j = i + 2;

          while (j + 1 < blocks.length) {
            const aNext = blocks[j];
            const bNext = blocks[j + 1];
            if (
              aNext.kind !== "steady" ||
              bNext.kind !== "steady" ||
              !blocksSimilar(firstA, aNext, DUR_TOL, PWR_TOL) ||
              !blocksSimilar(firstB, bNext, DUR_TOL, PWR_TOL)
            ) {
              break;
            }
            repeat++;
            j += 2;
          }

          if (repeat >= 2) {
            // By design: the first block is the "on" interval,
            // and the second is the "off" / recovery, even if "on" has lower power.
            const onBlock = firstA;
            const offBlock = firstB;

            const onDur = Math.round(onBlock.duration);
            const offDur = Math.round(offBlock.duration);

            const attrs = {
              Repeat: String(repeat),
              OnDuration: String(onDur),
              OffDuration: String(offDur),
              OnPower: onBlock.power.toFixed(8),
              OffPower: offBlock.power.toFixed(8)
            };

            if (onBlock.cadence != null && Number.isFinite(onBlock.cadence)) {
              attrs.Cadence = String(Math.round(onBlock.cadence));
            }
            if (
              offBlock.cadence != null &&
              Number.isFinite(offBlock.cadence)
            ) {
              attrs.CadenceResting = String(Math.round(offBlock.cadence));
            }

            xmlBlocks.push({
              type: "IntervalsT",
              attrs
            });

            i += repeat * 2;
            continue;
          }
        }
      }

      // Fallback: output individual block
      const b = blocks[i];
      if (b.kind === "steady") {
        const attrs = {
          Duration: String(Math.round(b.duration)),
          Power: b.power.toFixed(8)
        };
        if (b.cadence != null && Number.isFinite(b.cadence)) {
          attrs.Cadence = String(Math.round(b.cadence));
        }
        xmlBlocks.push({
          type: "SteadyState",
          attrs
        });
      } else if (b.kind === "rampUp") {
        const attrs = {
          Duration: String(Math.round(b.duration)),
          PowerLow: b.powerLow.toFixed(8),
          PowerHigh: b.powerHigh.toFixed(8)
        };
        if (b.cadence != null && Number.isFinite(b.cadence)) {
          attrs.Cadence = String(Math.round(b.cadence));
        }
        xmlBlocks.push({
          type: "Warmup",
          attrs
        });
      } else if (b.kind === "rampDown") {
        const attrs = {
          Duration: String(Math.round(b.duration)),
          PowerLow: b.powerLow.toFixed(8),
          PowerHigh: b.powerHigh.toFixed(8)
        };
        if (b.cadence != null && Number.isFinite(b.cadence)) {
          attrs.Cadence = String(Math.round(b.cadence));
        }
        xmlBlocks.push({
          type: "Cooldown",
          attrs
        });
      }
      i++;
    }

    return xmlBlocks;
  }

  // ---------- Metric helpers (computed from segments, all sites) ----------

  function blocksToMetricSegments(blocks) {
    const segs = [];
    if (!Array.isArray(blocks)) return segs;
    for (const b of blocks) {
      const dur = Math.max(0, Number(b.duration) || 0);
      if (dur <= 0) continue;
      if (b.kind === "steady") {
        segs.push({
          durationSec: dur,
          pStartRel: b.power,
          pEndRel: b.power
        });
      } else if (b.kind === "rampUp" || b.kind === "rampDown") {
        segs.push({
          durationSec: dur,
          pStartRel: b.powerLow,
          pEndRel: b.powerHigh
        });
      }
    }
    return segs;
  }

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

  // ---------- Metadata / category helpers ----------

  function cdataWrap(str) {
    if (!str) return "<![CDATA[]]>";
    const safe = String(str).replace("]]>", "]]&gt;");
    return `<![CDATA[${safe}]]>`;
  }

  function buildMetaFromTrainerRoad(summary, url, inferredCategory) {
    const s = summary || {};
    const name =
      s.workoutName ||
      (s.id != null ? `TrainerRoad Workout ${s.id}` : "TrainerRoad Workout");

    let description =
      s.workoutDescription || s.goalDescription || "Converted from TrainerRoad.";

    // Append TrainerRoad progression info to description only
    if (s.progression && s.progression.text) {
      const lvl =
        typeof s.progressionLevel === "number"
          ? s.progressionLevel.toFixed(2)
          : null;
      const progText = lvl
        ? `${s.progression.text} ${lvl}`
        : s.progression.text;
      description +=
        (description ? "\n\n" : "") +
        `TrainerRoad progression: ${progText}`;
    }

    const category = inferredCategory || "Uncategorized";

    return {
      source: "TrainerRoad",
      name,
      description,
      category,
      url
    };
  }

  function buildMetaFromTrainerDay(details, url, inferredCategory) {
    const d = details || {};
    const title = d.title || document.title || "TrainerDay Workout";
    const description = d.description || "Converted from TrainerDay.";
    const category = inferredCategory || "Uncategorized";

    return {
      source: "TrainerDay",
      name: title,
      description,
      category,
      url
    };
  }

  // Improved category heuristic based on "work" time rather than total time.
  // rawSegments: array of [durationMinutes, startPct, endPct?]
  // Returns one of: "Recovery", "Base", "SweetSpot", "Threshold",
  // "VO2Max", "HIIT", "Uncategorized"
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
      else if (avgPct < 76) zoneKey = "base";         // 55–75
      else if (avgPct < 88) zoneKey = "tempo";        // 76–87
      else if (avgPct < 95) zoneKey = "sweetSpot";    // 88–94
      else if (avgPct < 106) zoneKey = "threshold";   // 95–105
      else if (avgPct < 121) zoneKey = "vo2";         // 106–120
      else zoneKey = "anaerobic";                     // >120

      zoneTime[zoneKey] += durSec;

      // "Work" time is anything ≥ ~tempo (>= 75% FTP)
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

    // If almost no time spent working above ~75% FTP,
    // treat as Recovery or Base regardless of short spikes.
    if (workFrac < 0.15) {
      if (z.recovery / totalSec >= 0.7) return "Recovery";
      return "Base";
    }

    const safeDiv = workSec || 1;
    const fracWork = {
      hi: hiSec / safeDiv,                               // VO2 + anaerobic
      thr: thrSec / safeDiv,
      ss: ssSec / safeDiv,
      tempo: tempoSec / safeDiv
    };

    // 1) High-intensity dominated workouts → HIIT / VO2Max
    if (fracWork.hi >= 0.25) {
      const anaerFrac = z.anaerobic / safeDiv;
      if (anaerFrac >= 0.15) {
        return "HIIT";
      }
      return "VO2Max";
    }

    // 2) Threshold-centric hard workouts
    if (fracWork.thr + fracWork.hi >= 0.4) {
      return "Threshold";
    }

    // 3) SweetSpot-centric
    if (fracWork.ss + fracWork.thr >= 0.4 || fracWork.ss >= 0.3) {
      return "SweetSpot";
    }

    // 4) Tempo-heavy → still closer to "SweetSpot" / sub-threshold work
    if (fracWork.tempo >= 0.5) {
      return "SweetSpot";
    }

    // 5) Everything else with some work → Base
    return "Base";
  }

  // WhatsOnZwift DOM extraction helpers

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

  // Returns array of { minutes, startPct, endPct, cadence }
  function extractWozSegmentsFromDom() {
    const container = document.querySelector("div.order-2");
    if (!container) {
      console.warn("[ZWO Downloader][WhatsOnZwift] order-2 container not found.");
      return [];
    }
    const bars = Array.from(container.querySelectorAll(".textbar"));
    const segments = [];

    for (const bar of bars) {
      const text = (bar.textContent || "").replace(/\s+/g, " ").trim();
      const powSpans = bar.querySelectorAll('span[data-unit="relpow"][data-value]');

      // --- Special case: Intervals like "5x 4min @ 72% FTP, 2min @ 52% FTP"
      // or using seconds: "5x 30sec @ 120% FTP, 30sec @ 40% FTP" ---
      const repMatch = text.match(/(\d+)\s*x\b/i);
      if (repMatch && powSpans.length >= 2) {
        const reps = parseInt(repMatch[1], 10);
        if (Number.isFinite(reps) && reps > 0) {
          // Capture durations with their units (min or sec)
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
                // On segment
                segments.push({
                  minutes: onMinutes,
                  startPct: pOn,
                  endPct: pOn,
                  cadence: null
                });
                // Off / recovery segment
                segments.push({
                  minutes: offMinutes,
                  startPct: pOff,
                  endPct: pOff,
                  cadence: null
                });
              }
              continue; // handled this bar completely
            }
          }
        }
      }

      // --- Regular single-interval bars (including ramps & seconds) ---

      // Duration: first try minutes, then seconds
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

      // Optional cadence "@ 85rpm"
      const cadenceMatch = text.match(/@\s*(\d+)\s*rpm/i);
      const cadence = cadenceMatch ? Number(cadenceMatch[1]) : null;

      if (powSpans.length === 1) {
        const pct = Number(powSpans[0].getAttribute("data-value"));
        if (!Number.isFinite(pct)) continue;
        segments.push({
          minutes,
          startPct: pct,
          endPct: pct,
          cadence
        });
      } else if (powSpans.length >= 2) {
        const pctLow = Number(powSpans[0].getAttribute("data-value"));
        const pctHigh = Number(powSpans[1].getAttribute("data-value"));
        if (!Number.isFinite(pctLow) || !Number.isFinite(pctHigh)) continue;
        segments.push({
          minutes,
          startPct: pctLow,
          endPct: pctHigh,
          cadence
        });
      } else {
        // no relpow span found; skip
        continue;
      }
    }

    return segments;
  }

  function buildMetaFromWhatsonZwift(rawSegments, url) {
    const name = extractWozTitle();
    const rawDescription = extractWozDescription();
    const category = inferCategoryFromSegments(rawSegments);
    const description = rawDescription || "Converted from WhatsOnZwift.";

    return {
      source: "WhatsOnZwift",
      name,
      description,
      category,
      url
    };
  }

  function cdataWrap(str) {
    if (!str) return "<![CDATA[]]>";
    const safe = String(str).replace("]]>", "]]&gt;");
    return `<![CDATA[${safe}]]>`;
  }

  // ---------- ZWO XML builder ----------

  function toZwoXmlFromBlocksAndMeta(blocks, meta, metrics) {
    const xmlBlocks = compressToXmlBlocks(blocks);

    const source = meta.source || "Unknown";
    const name = meta.name || "Workout";
    const category = meta.category || "Uncategorized";
    let description = meta.description || "";

    const tss = metrics && typeof metrics.tss === "number" ? metrics.tss : null;
    const kj = metrics && typeof metrics.kj === "number" ? metrics.kj : null;
    const ifValue =
      metrics && typeof metrics.ifValue === "number" ? metrics.ifValue : null;
    const durationMin =
      metrics && typeof metrics.durationMin === "number"
        ? metrics.durationMin
        : null;
    const ftp =
      metrics && typeof metrics.ftp === "number" ? metrics.ftp : null;

    // Only put TSS, IF, and Duration in description (no kJ or FTP).
    const metricsList = [];
    if (tss != null) metricsList.push(`TSS: ${Math.round(tss)}`);
    if (ifValue != null) metricsList.push(`IF: ${ifValue.toFixed(2)}`);
    if (durationMin != null)
      metricsList.push(`Duration: ${Math.round(durationMin)} min`);

    if (metricsList.length > 0) {
      description +=
        (description ? "\n\n" : "") + `Metrics: ${metricsList.join(", ")}`;
    }

    // Tags still include kJ and FTP so the options UI can read them later.
    const tags = [];
    tags.push({name: source});
    tags.push({name: category});
    if (tss != null) tags.push({name: `TSS ${Math.round(tss)}`});
    if (kj != null) tags.push({name: `kJ ${Math.round(kj)}`});
    if (ifValue != null)
      tags.push({name: `IF ${ifValue.toFixed(2)}`});
    if (durationMin != null)
      tags.push({name: `Duration:${Math.round(durationMin)}min`});
    if (ftp != null)
      tags.push({name: `FTP:${Math.round(ftp)}`});
    if (meta.url) tags.push({name: `URL:${meta.url}`});

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
  <author>${source} zwo-downloader</author>
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

  async function downloadZwo(zwoXml, filename) {
    // First, try to ask the background script to save into the user-selected folder.
    let handledByDirectory = false;

    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        handledByDirectory = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage(
              {
                type: "TR2ZWO_SAVE_TO_DIR",
                xml: zwoXml,
                filename
              },
              (resp) => {
                const lastError = chrome.runtime && chrome.runtime.lastError
                  ? chrome.runtime.lastError
                  : null;

                console.log(
                  "[ZWO Downloader] Background save response:",
                  resp,
                  "lastError:",
                  lastError
                );

                // If the background is missing or errored, lastError will be set.
                if (lastError) {
                  console.warn(
                    "[ZWO Downloader] Background save failed or not available:",
                    lastError.message
                  );
                  resolve(false);
                  return;
                }

                if (resp && resp.ok) {
                  console.log("[ZWO Downloader] Saved ZWO file successfully to directory:", filename);
                  resolve(true);
                } else {
                  console.warn(
                    "[ZWO Downloader] Background reported failure saving ZWO:",
                    resp && resp.reason ? resp.reason : resp
                  );
                  resolve(false);
                }
              }
            );
          } catch (e) {
            console.warn("[ZWO Downloader] Error sending save message:", e);
            resolve(false);
          }
        });
      }
    } catch (err) {
      console.warn("[ZWO Downloader] Error during background save attempt:", err);
      handledByDirectory = false;
    }

    if (handledByDirectory) {
      // Saved successfully to the user-selected directory; nothing else to do.
      return;
    }

    // Fallback: original behavior – download to default browser Downloads folder via <a download>
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

  function showFailureAlert() {
    try {
      alert(
        "ZWO Downloader: Failed to generate a workout for this page.\n\n" +
        "Make sure you are on a supported workout page (TrainerRoad, TrainerDay, or WhatsOnZwift) and try again."
      );
    } catch {
      // ignore alert issues
    }
  }

  // ---------- Site-specific generators (return true/false for success) ----------

  async function generateTrainerRoadZwo(shouldDownload) {
    const match = window.location.pathname.match(TRAINERROAD_WORKOUT_REGEX);
    if (!match) {
      console.info("[ZWO Downloader][TrainerRoad] Not on a workout add page.");
      return false;
    }
    const workoutId = match[1];

    try {
      // Always use a fixed FTP of 250 for ZWO metrics
      const ftp = DEFAULT_FTP;

      const chartUrl = `${BASE_TRAINERROAD}/app/api/workouts/${workoutId}/chart-data`;
      const summaryUrl = `${BASE_TRAINERROAD}/app/api/workouts/${workoutId}/summary?withDifficultyRating=true`;

      console.info("[ZWO Downloader][TrainerRoad] Fetching chart data:", chartUrl);
      const chartData = await fetchTrainerRoadJson(chartUrl);

      console.info("[ZWO Downloader][TrainerRoad] Fetching metadata:", summaryUrl);
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
        console.warn(
          "[ZWO Downloader][TrainerRoad] No CourseData array found in chart response.",
          chartData
        );
        return false;
      }

      const samples = buildSamples(courseData);
      const blocks = buildBlocksFromSamples(samples);

      // Build raw segments for category inference: [minutes, startPct, endPct]
      const rawSegmentsForCategory = [];
      for (const b of blocks) {
        const durSec = Number(b.duration) || 0;
        if (durSec <= 0) continue;
        const minutes = durSec / 60;
        let startPct, endPct;
        if (b.kind === "steady") {
          const pct = (b.power || 0) * 100;
          startPct = pct;
          endPct = pct;
        } else if (b.kind === "rampUp" || b.kind === "rampDown") {
          startPct = (b.powerLow || 0) * 100;
          endPct = (b.powerHigh || 0) * 100;
        } else {
          continue;
        }
        rawSegmentsForCategory.push([minutes, startPct, endPct]);
      }
      const inferredCategory = inferCategoryFromSegments(rawSegmentsForCategory);

      const metricSegments = blocksToMetricSegments(blocks);
      const metrics = computeMetricsFromSegments(metricSegments, ftp);
      const meta = buildMetaFromTrainerRoad(
        summary,
        window.location.href,
        inferredCategory
      );

      const zwoXml = toZwoXmlFromBlocksAndMeta(blocks, meta, metrics);
      const baseName = meta.name || "Workout";
      const safeBase = baseName.replace(/[^\w\-]+/g, "_");
      const filename = `${safeBase}.zwo`;

      console.info("===== TrainerRoad → ZWO XML =====");
      console.info(zwoXml);
      console.info("===== End ZWO XML =====");

      if (shouldDownload) {
        await downloadZwo(zwoXml, filename);
      }

      return true;
    } catch (err) {
      console.warn("[ZWO Downloader][TrainerRoad] Error building ZWO:", err);
      return false;
    }
  }

  async function generateTrainerDayZwo(shouldDownload) {
    const path = window.location.pathname;
    const match = path.match(TRAINERDAY_WORKOUT_REGEX);
    if (!match) {
      console.info("[ZWO Downloader][TrainerDay] Not on a workout page.");
      return false;
    }
    const slug = match[1];

    try {
      // Always use a fixed FTP of 250 for ZWO metrics
      const ftp = DEFAULT_FTP;
      const url = window.location.href;
      console.info("[ZWO Downloader][TrainerDay] Fetching workout by slug:", slug);
      const details = await fetchTrainerDayWorkoutBySlug(slug);

      const segments =
        Array.isArray(details.segments) ? details.segments : null;

      if (!segments || segments.length === 0) {
        console.warn(
          "[ZWO Downloader][TrainerDay] No segments in workout data:",
          details
        );
        return false;
      }

      const blocks = buildBlocksFromSegments(segments);
      const metricSegments = blocksToMetricSegments(blocks);
      const metrics = computeMetricsFromSegments(metricSegments, ftp);

      // Category inferred from TrainerDay segments
      const inferredCategory = inferCategoryFromSegments(segments);
      const meta = buildMetaFromTrainerDay(details, url, inferredCategory);

      const zwoXml = toZwoXmlFromBlocksAndMeta(blocks, meta, metrics);
      const baseName = meta.name || "Workout";
      const safeBase = baseName.replace(/[^\w\-]+/g, "_");
      const filename = `${safeBase}.zwo`;

      console.info("===== TrainerDay → ZWO XML =====");
      console.info(zwoXml);
      console.info("===== End ZWO XML =====");

      if (shouldDownload) {
        await downloadZwo(zwoXml, filename);
      }

      return true;
    } catch (err) {
      console.warn("[ZWO Downloader][TrainerDay] Error building ZWO:", err);
      return false;
    }
  }

  async function generateWhatsonZwiftZwo(shouldDownload) {
    const path = window.location.pathname;
    if (!WHATSONZWIFT_WORKOUT_REGEX.test(path)) {
      console.info("[ZWO Downloader][WhatsOnZwift] Not on a workout page.");
      return false;
    }

    try {
      // Always use a fixed FTP of 250 for ZWO metrics
      const ftp = DEFAULT_FTP;
      const url = window.location.href;

      const wozSegments = extractWozSegmentsFromDom();
      if (!wozSegments || wozSegments.length === 0) {
        console.warn(
          "[ZWO Downloader][WhatsOnZwift] No segments extracted from DOM."
        );
        return false;
      }

      // For category heuristic we only need minutes + %FTP
      const rawSegmentsForCategory = wozSegments.map((s) => [
        s.minutes,
        s.startPct,
        s.endPct
      ]);

      // Build blocks with cadence info
      const blocks = [];
      for (const seg of wozSegments) {
        const minutes = Number(seg.minutes);
        const startPct = Number(seg.startPct);
        const endPct =
          seg.endPct != null ? Number(seg.endPct) : Number(seg.startPct);
        const cadence =
          seg.cadence != null && Number.isFinite(seg.cadence)
            ? Number(seg.cadence)
            : null;

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
            power: pStart,
            cadence
          });
        } else if (pEnd > pStart) {
          blocks.push({
            kind: "rampUp",
            duration,
            powerLow: pStart,
            powerHigh: pEnd,
            cadence
          });
        } else {
          blocks.push({
            kind: "rampDown",
            duration,
            powerLow: pStart,
            powerHigh: pEnd,
            cadence
          });
        }
      }

      const metricSegments = blocksToMetricSegments(blocks);
      const metrics = computeMetricsFromSegments(metricSegments, ftp);
      const meta = buildMetaFromWhatsonZwift(
        rawSegmentsForCategory,
        url
      );

      const zwoXml = toZwoXmlFromBlocksAndMeta(blocks, meta, metrics);
      const baseName = meta.name || "Workout";
      const safeBase = baseName.replace(/[^\w\-]+/g, "_");
      const filename = `${safeBase}.zwo`;

      console.info("===== WhatsOnZwift → ZWO XML =====");
      console.info(zwoXml);
      console.info("===== End ZWO XML =====");

      if (shouldDownload) {
        await downloadZwo(zwoXml, filename);
      }

      return true;
    } catch (err) {
      console.warn("[ZWO Downloader][WhatsOnZwift] Error building ZWO:", err);
      return false;
    }
  }

  // ---------- Main dispatcher ----------

  async function generateZwoForCurrentPage(shouldDownload) {
    const site = getSiteType();
    if (site === "trainerroad") {
      return await generateTrainerRoadZwo(shouldDownload);
    } else if (site === "trainerday") {
      return await generateTrainerDayZwo(shouldDownload);
    } else if (site === "whatsonzwift") {
      return await generateWhatsonZwiftZwo(shouldDownload);
    } else {
      console.info("[ZWO Downloader] Unsupported site:", location.host);
      return false;
    }
  }

  // Expose a manual trigger for downloading from DevTools:
  window.tr2zwoDownload = async function () {
    const ok = await generateZwoForCurrentPage(true);
    if (!ok) {
      showFailureAlert();
    }
  };

  // Listen for messages from background.js (toolbar icon click)
  if (
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    chrome.runtime.onMessage
  ) {
    chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
      if (msg && msg.type === "TR2ZWO_DOWNLOAD") {
        (async () => {
          const ok = await generateZwoForCurrentPage(true);
          if (!ok) {
            showFailureAlert();
          }
        })();
      }
    });
  }
})();

