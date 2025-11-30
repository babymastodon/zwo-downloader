// zwo.js
//
// Canonical workout representation + conversion to/from ZWO,
// plus inline ZWO parsing.
//
// This file is intentionally standalone (no DOM or fetch dependencies).

/**
 * Canonical representation of a scraped workout.
 *
 * @typedef CanonicalWorkout
 * @property {string} source
 *   e.g. "TrainerRoad" | "TrainerDay" | "WhatsOnZwift" | "Unknown"
 * @property {string} sourceURL
 *   Original workout page URL
 * @property {string} workoutTitle
 *   Human-readable workout title
 * @property {Array<[number, number, number]>} rawSegments
 *   Canonical segments: [minutes, startPower, endPower]
 *   - minutes: duration in minutes (float allowed)
 *   - startPower: % FTP or equivalent "start power" (0–100 usually)
 *   - endPower: % FTP or equivalent "end power" (0–100 usually)
 * @property {string} description
 *   Human-readable description/notes
 */

// ---------------- Safety limits for ZWO parsing ----------------

const ZWO_MAX_SEGMENT_DURATION_SEC = 12 * 3600; // 12 hours per segment
const ZWO_MAX_WORKOUT_DURATION_SEC = 24 * 3600; // 24 hours total workout
const ZWO_MAX_INTERVAL_REPEATS = 500; // sanity cap on repeats

// ---------------- Small helpers ----------------

function escapeXml(text) {
  return (text || "").replace(/[<>&'"]/g, (ch) => {
    switch (ch) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return ch;
    }
  });
}

function unescapeXml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function cdataWrap(text) {
  if (!text) return "<![CDATA[]]>";
  const safe = String(text).replace("]]>", "]]&gt;");
  return "<![CDATA[" + safe + "]]>";
}

function cdataUnwrap(text) {
  if (!text) return "";
  const str = String(text).trim();
  if (str.startsWith("<![CDATA[") && str.endsWith("]]>")) {
    const inner = str.slice(9, -3);
    return inner.replace("]]&gt;", "]]>");
  }
  return str;
}

// ---------------- Inline ZWO snippet parser ----------------

/**
 * Parse a ZWO-style snippet containing SteadyState / Warmup / Cooldown / IntervalsT
 * into canonical rawSegments and syntax errors.
 *
 * Returns:
 *   rawSegments: Array<[minutes:number, startPct:number, endPct:number]>
 *     where minutes is the segment duration in minutes,
 *     and startPct / endPct are FTP percentages (0–100).
 *
 * Errors have:
 *   { start: number, end: number, message: string }
 *
 * Safety limits (enforced by helper handlers):
 *   - Max per-segment duration  : 12 hours equivalent in minutes
 *   - Max total IntervalsT time : 24 hours equivalent
 *   - Max IntervalsT repeats    : 500
 *
 * @param {string} text
 * @returns {{rawSegments:Array<[number,number,number]>, errors:Array<{start:number,end:number,message:string}>}}
 */
export function parseZwoSnippet(text) {
  /** @type {Array<{durationSec:number,pStartRel:number,pEndRel:number}>} */
  const segments = [];
  const errors = [];

  const raw = (text || "")
    .replace(/<\s*workout[^>]*>/gi, "")
    .replace(/<\/\s*workout\s*>/gi, "");
  const trimmed = raw.trim();
  if (!trimmed) return {rawSegments: [], errors};

  const tagRegex = /<([A-Za-z]+)\b([^>]*)\/>/g;
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(trimmed)) !== null) {
    const full = match[0];
    const tagName = match[1];
    const attrsText = match[2] || "";
    const startIdx = match.index;
    const endIdx = startIdx + full.length;

    const between = trimmed.slice(lastIndex, startIdx);
    if (between.trim().length > 0) {
      errors.push({
        start: lastIndex,
        end: startIdx,
        message: "Unexpected text between elements; only ZWO workout elements are allowed.",
      });
    }

    const {attrs, hasGarbage} = parseZwoAttributes(attrsText);

    if (hasGarbage) {
      errors.push({
        start: startIdx,
        end: endIdx,
        message: "Malformed element: unexpected text or tokens inside element.",
      });
      lastIndex = endIdx;
      continue;
    }

    switch (tagName) {
      case "SteadyState":
        handleZwoSteady(attrs, segments, errors, startIdx, endIdx);
        break;
      case "Warmup":
      case "Cooldown":
        handleZwoRamp(tagName, attrs, segments, errors, startIdx, endIdx);
        break;
      case "IntervalsT":
        handleZwoIntervals(attrs, segments, errors, startIdx, endIdx);
        break;
      default:
        errors.push({
          start: startIdx,
          end: endIdx,
          message: `Unknown element <${tagName}>`,
        });
        break;
    }

    lastIndex = endIdx;
  }

  const trailing = trimmed.slice(lastIndex);
  if (trailing.trim().length > 0) {
    errors.push({
      start: lastIndex,
      end: lastIndex + trailing.length,
      message: "Trailing text after last element.",
    });
  }

  const rawSegments = segments.map((seg) => ([
    seg.durationSec / 60,   // minutes
    seg.pStartRel * 100,    // startPct
    seg.pEndRel * 100       // endPct
  ]));

  return {rawSegments, errors};
}

function parseZwoAttributes(attrText) {
  const attrs = {};
  let hasGarbage = false;

  const attrRegex =
    /([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*"([^"]*)"/g;

  let m;
  let lastIndex = 0;

  while ((m = attrRegex.exec(attrText)) !== null) {
    if (m.index > lastIndex) {
      const between = attrText.slice(lastIndex, m.index);
      if (between.trim().length > 0) hasGarbage = true;
    }

    attrs[m[1]] = m[2];
    lastIndex = attrRegex.lastIndex;
  }

  const trailing = attrText.slice(lastIndex);
  if (trailing.trim().length > 0) hasGarbage = true;

  return {attrs, hasGarbage};
}

function handleZwoSteady(attrs, segments, errors, start, end) {
  const duration = attrs.Duration != null ? Number(attrs.Duration) : NaN;
  const power = attrs.Power != null ? Number(attrs.Power) : NaN;

  if (!validateZwoDuration(duration, "SteadyState", start, end, errors)) return;
  if (!Number.isFinite(power) || power <= 0) {
    errors.push({
      start,
      end,
      message:
        "SteadyState must have a positive numeric Power (relative FTP, e.g. 0.75).",
    });
    return;
  }

  segments.push({
    durationSec: duration,
    pStartRel: power,
    pEndRel: power,
  });
}

function handleZwoRamp(tagName, attrs, segments, errors, start, end) {
  const duration = attrs.Duration != null ? Number(attrs.Duration) : NaN;
  const pLow = attrs.PowerLow != null ? Number(attrs.PowerLow) : NaN;
  const pHigh = attrs.PowerHigh != null ? Number(attrs.PowerHigh) : NaN;

  if (!validateZwoDuration(duration, tagName, start, end, errors)) return;
  if (!Number.isFinite(pLow) || !Number.isFinite(pHigh)) {
    errors.push({
      start,
      end,
      message: `${tagName} must have PowerLow and PowerHigh as numbers (relative FTP).`,
    });
    return;
  }

  segments.push({
    durationSec: duration,
    pStartRel: pLow,
    pEndRel: pHigh,
  });
}

function validateZwoDuration(duration, tagName, start, end, errors) {
  if (!Number.isFinite(duration) || duration <= 0) {
    errors.push({
      start,
      end,
      message: `${tagName} must have a positive numeric Duration (seconds).`,
    });
    return false;
  }
  if (duration > ZWO_MAX_SEGMENT_DURATION_SEC) {
    errors.push({
      start,
      end,
      message: `${tagName} Duration is unrealistically large (max ${ZWO_MAX_SEGMENT_DURATION_SEC} seconds).`,
    });
    return false;
  }
  return true;
}

function handleZwoIntervals(attrs, segments, errors, start, end) {
  const repeat = attrs.Repeat != null ? Number(attrs.Repeat) : NaN;
  const onDur = attrs.OnDuration != null ? Number(attrs.OnDuration) : NaN;
  const offDur = attrs.OffDuration != null ? Number(attrs.OffDuration) : NaN;
  const onPow = attrs.OnPower != null ? Number(attrs.OnPower) : NaN;
  const offPow = attrs.OffPower != null ? Number(attrs.OffPower) : NaN;

  if (!Number.isFinite(repeat) || repeat <= 0 || repeat > ZWO_MAX_INTERVAL_REPEATS) {
    errors.push({
      start,
      end,
      message: `IntervalsT must have Repeat as a positive integer (max ${ZWO_MAX_INTERVAL_REPEATS}).`,
    });
    return;
  }

  if (!validateZwoDuration(onDur, "IntervalsT OnDuration", start, end, errors)) return;
  if (!validateZwoDuration(offDur, "IntervalsT OffDuration", start, end, errors)) return;

  const totalBlockSec = repeat * (onDur + offDur);
  if (!Number.isFinite(totalBlockSec) || totalBlockSec > ZWO_MAX_WORKOUT_DURATION_SEC) {
    errors.push({
      start,
      end,
      message: "IntervalsT total duration is unrealistically large.",
    });
    return;
  }
  if (!Number.isFinite(onPow) || !Number.isFinite(offPow)) {
    errors.push({
      start,
      end,
      message:
        "IntervalsT must have numeric OnPower and OffPower (relative FTP).",
    });
    return;
  }

  const reps = Math.round(repeat);
  for (let i = 0; i < reps; i++) {
    segments.push({
      durationSec: onDur,
      pStartRel: onPow,
      pEndRel: onPow,
    });
    segments.push({
      durationSec: offDur,
      pStartRel: offPow,
      pEndRel: offPow,
    });
  }
}

// ---------------- Canonical segments -> ZWO body ----------------

/**
 * segments: [minutes, startPower, endPower]
 * Detects repeated steady on/off pairs and emits IntervalsT when possible.
 *
 * startPower/endPower are assumed to be in “FTP-relative” units where:
 *   - <= 5 → treated as 0–1 (fraction of FTP)
 *   - >  5 → treated as 0–100 (% of FTP)
 *
 * @param {Array<[number, number, number]>} segments
 * @returns {string} ZWO <workout> body lines joined by "\n"
 */
export function segmentsToZwoSnippet(segments) {
  if (!Array.isArray(segments) || !segments.length) return "";

  const blocks = [];

  // ---------- 1) segments -> normalized blocks ----------
  for (const seg of segments) {
    if (!Array.isArray(seg) || seg.length < 2) continue;

    const minutes = Number(seg[0]);
    let startVal = Number(seg[1]);
    let endVal = seg.length > 2 && seg[2] != null ? Number(seg[2]) : startVal;

    if (
      !Number.isFinite(minutes) ||
      minutes <= 0 ||
      !Number.isFinite(startVal) ||
      !Number.isFinite(endVal)
    ) {
      continue;
    }

    const toRel = (v) => (v <= 5 ? v : v / 100);

    const durationSec = minutes * 60;
    const pStartRel = toRel(startVal);
    const pEndRel = toRel(endVal);

    if (durationSec <= 0) continue;

    if (Math.abs(pStartRel - pEndRel) < 1e-6) {
      blocks.push({kind: "steady", durationSec, powerRel: pStartRel});
    } else if (pEndRel > pStartRel) {
      blocks.push({
        kind: "rampUp",
        durationSec,
        powerLowRel: pStartRel,
        powerHighRel: pEndRel,
      });
    } else {
      blocks.push({
        kind: "rampDown",
        durationSec,
        powerLowRel: pStartRel,
        powerHighRel: pEndRel,
      });
    }
  }

  if (!blocks.length) return "";

  // ---------- 2) compress blocks -> ZWO lines ----------
  const lines = [];
  const DUR_TOL = 1;   // seconds
  const PWR_TOL = 0.01; // relative FTP

  let i = 0;

  while (i < blocks.length) {
    // Try to detect repeated steady on/off pairs → IntervalsT
    if (i + 3 < blocks.length) {
      const firstA = blocks[i];
      const firstB = blocks[i + 1];

      if (firstA.kind === "steady" && firstB.kind === "steady") {
        let repeat = 1;
        let j = i + 2;

        while (j + 1 < blocks.length) {
          const nextA = blocks[j];
          const nextB = blocks[j + 1];

          if (
            nextA.kind !== "steady" ||
            nextB.kind !== "steady" ||
            !blocksSimilarSteady(firstA, nextA, DUR_TOL, PWR_TOL) ||
            !blocksSimilarSteady(firstB, nextB, DUR_TOL, PWR_TOL)
          ) break;

          repeat++;
          j += 2;
        }

        if (repeat >= 2) {
          const onDur = Math.round(firstA.durationSec);
          const offDur = Math.round(firstB.durationSec);
          const onPow = firstA.powerRel.toFixed(2);
          const offPow = firstB.powerRel.toFixed(2);

          lines.push(
            `<IntervalsT Repeat="${repeat}"` +
            ` OnDuration="${onDur}" OffDuration="${offDur}"` +
            ` OnPower="${onPow}" OffPower="${offPow}" />`
          );

          i += repeat * 2;
          continue;
        }
      }
    }

    const b = blocks[i];

    if (b.kind === "steady") {
      lines.push(
        `<SteadyState Duration="${Math.round(
          b.durationSec
        )}" Power="${b.powerRel.toFixed(2)}" />`
      );
    } else if (b.kind === "rampUp") {
      lines.push(
        `<Warmup Duration="${Math.round(
          b.durationSec
        )}" PowerLow="${b.powerLowRel.toFixed(
          2
        )}" PowerHigh="${b.powerHighRel.toFixed(2)}" />`
      );
    } else if (b.kind === "rampDown") {
      lines.push(
        `<Cooldown Duration="${Math.round(
          b.durationSec
        )}" PowerLow="${b.powerLowRel.toFixed(
          2
        )}" PowerHigh="${b.powerHighRel.toFixed(2)}" />`
      );
    }

    i++;
  }

  return lines.join("\n");
}

function blocksSimilarSteady(a, b, durTolSec, pwrTol) {
  if (a.kind !== "steady" || b.kind !== "steady") return false;
  const durDiff = Math.abs(a.durationSec - b.durationSec);
  const pDiff = Math.abs(a.powerRel - b.powerRel);
  return durDiff <= durTolSec && pDiff <= pwrTol;
}

// ---------------- CanonicalWorkout -> ZWO XML ----------------

/**
 * Build a full ZWO XML file from a CanonicalWorkout.
 *
 * The original source URL is included:
 *   - Appended to the description inside CDATA
 *   - As a tag: <tag name="OriginalURL:..."/>
 *
 * The source is *not* encoded in tags; it is just the <author>.
 *
 * @param {CanonicalWorkout} meta
 * @param {Object} [options]
 * @param {string} [options.sportType]  - Zwift sportType (default: "bike")
 * @returns {string} ZWO XML content
 */
export function canonicalWorkoutToZwoXml(meta) {
  const {
    source = "Unknown",
    sourceURL = "",
    workoutTitle = "",
    rawSegments = [],
    description = "",
  } = meta || {};

  const name =
    (workoutTitle || "Custom workout").trim() || "Custom workout";
  const author =
    (source || "External workout").trim() || "External workout";

  const workoutSnippet = segmentsToZwoSnippet(rawSegments);

  let descCombined = description || "";
  if (sourceURL) {
    const urlLine = `Original workout URL: ${sourceURL}`;
    descCombined = descCombined
      ? `${descCombined}\n\n${urlLine}`
      : urlLine;
  }

  const urlTag = sourceURL
    ? `    <tag name="OriginalURL:${escapeXml(sourceURL)}"/>\n`
    : "";

  const indentedBody = workoutSnippet
    ? workoutSnippet
      .split("\n")
      .map((line) => "    " + line)
      .join("\n")
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<workout_file>
  <author>${escapeXml(author)}</author>
  <name>${escapeXml(name)}</name>
  <description>${cdataWrap(descCombined)}</description>
  <sportType>bike</sportType>
  <tags>
${urlTag}  </tags>
  <workout>
${indentedBody}
  </workout>
</workout_file>
`;
}

/**
 * Simple inverse of canonicalWorkoutToZwoXml:
 * Parse a full ZWO XML file into a CanonicalWorkout.
 *
 * This uses basic string-based parsing (not a full XML parser) and
 * focuses on the common fields produced by canonicalWorkoutToZwoXml.
 *
 * @param {string} xmlText
 * @returns {CanonicalWorkout|null}
 */
export function parseZwoXmlToCanonicalWorkout(xmlText) {
  if (!xmlText) return null;

  // Title
  const nameMatch = xmlText.match(/<name>([\s\S]*?)<\/name>/i);
  const workoutTitle = unescapeXml(
    cdataUnwrap(
      (nameMatch ? nameMatch[1] : "Imported workout").trim()
    )
  );

  // Description (strip "Original workout URL:" line if present)
  let description = "";
  const descMatch = xmlText.match(/<description>([\s\S]*?)<\/description>/i);
  if (descMatch) {
    const rawDesc = unescapeXml(cdataUnwrap(descMatch[1].trim()));
    description = rawDesc
      .split(/\r?\n/)
      .filter(
        (line) =>
          !line.trim().toLowerCase().startsWith("original workout url:")
      )
      .join("\n")
      .trim();
  }

  // Original URL tag (if present)
  let sourceURL = "";
  const urlTagMatch = xmlText.match(
    /<tag[^>]*\sname="OriginalURL:([^"]*)"/i
  );
  if (urlTagMatch) {
    sourceURL = unescapeXml(urlTagMatch[1]);
  }

  // Source = author if present, otherwise generic label
  let source = "Imported ZWO";
  const authorMatch = xmlText.match(/<author>([\s\S]*?)<\/author>/i);
  if (authorMatch) {
    source = unescapeXml(authorMatch[1].trim());
  }

  // Extract <workout> body and parse into canonical rawSegments
  const workoutMatch = xmlText.match(
    /<workout[^>]*>([\s\S]*?)<\/workout>/i
  );
  const workoutInner = workoutMatch ? workoutMatch[1] : "";
  const {rawSegments} = parseZwoSnippet(workoutInner);

  /** @type {CanonicalWorkout} */
  return {
    source,
    sourceURL,
    workoutTitle,
    rawSegments,
    description,
  };
}

