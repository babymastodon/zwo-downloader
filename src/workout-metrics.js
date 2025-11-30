// workout-metrics.js
// Pure workout metrics + ZWO parsing helpers shared across the app.

export const DEFAULT_FTP = 250;

// --------------------------- Segment scaling ---------------------------

/**
 * Take normalized workout segments (with durationSec, pStartRel, pEndRel)
 * and scale them into absolute watt targets & timeline.
 *
 * Returns:
 *   { scaledSegments, totalSec }
 */
export function computeScaledSegments(segments, ftp) {
  if (!Array.isArray(segments) || !segments.length) {
    return {scaledSegments: [], totalSec: 0};
  }

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

// --------------------------- Metrics from segments ---------------------------

/**
 * segments: [{ durationSec, pStartRel, pEndRel }, ...]
 * ftp: numeric FTP (W)
 */
export function computeMetricsFromSegments(segments, ftp) {
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

// --------------------------- Category inference ---------------------------

/**
 * rawSegments: [[minutes, startPct, endPct?], ...]
 * pct values are in % of FTP (e.g. 75 for 75%).
 */
export function inferCategoryFromSegments(rawSegments) {
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

  // Light / easy: mostly recovery / base
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

  if (fracWork.hi >= 0.2) {
    const anaerFrac = z.anaerobic / safeDiv;
    if (anaerFrac >= 0.1) {
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

// --------------------------- ZWO parsing helpers ---------------------------

/**
 * Extracts segments from a <workout_file> XML DOM.
 * Returns:
 *   segmentsForMetrics: [{ durationSec, pStartRel, pEndRel }, ...]
 *   segmentsForCategory: [[minutes, startPct, endPct], ...]
 */
export function extractSegmentsFromZwo(doc) {
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
      const dur = Number(
        el.getAttribute("Duration") || el.getAttribute("duration") || 0
      );
      const p = Number(
        el.getAttribute("Power") || el.getAttribute("power") || 0
      );
      if (dur > 0 && Number.isFinite(p)) {
        pushSeg(dur, p, p);
      }
    } else if (name === "warmup" || name === "cooldown") {
      const dur = Number(
        el.getAttribute("Duration") || el.getAttribute("duration") || 0
      );
      const pLow = Number(
        el.getAttribute("PowerLow") || el.getAttribute("powerlow") || 0
      );
      const pHigh = Number(
        el.getAttribute("PowerHigh") || el.getAttribute("powerhigh") || 0
      );
      if (dur > 0 && Number.isFinite(pLow) && Number.isFinite(pHigh)) {
        pushSeg(dur, pLow, pHigh);
      }
    } else if (name === "intervalst") {
      const repeat = Number(
        el.getAttribute("Repeat") || el.getAttribute("repeat") || 1
      );
      const onDur = Number(
        el.getAttribute("OnDuration") || el.getAttribute("onduration") || 0
      );
      const offDur = Number(
        el.getAttribute("OffDuration") || el.getAttribute("offduration") || 0
      );
      const onP = Number(
        el.getAttribute("OnPower") || el.getAttribute("onpower") || 0
      );
      const offP = Number(
        el.getAttribute("OffPower") || el.getAttribute("offpower") || 0
      );

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

/**
 * Parses .zwo XML text into a normalized workout meta object.
 */
export function parseZwo(xmlText, fileName) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  const nameEl = doc.querySelector("workout_file > name");
  const descEl = doc.querySelector("workout_file > description");
  const tagEls = Array.from(
    doc.querySelectorAll("workout_file > tags > tag")
  );

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

  const {segmentsForMetrics, segmentsForCategory} =
    extractSegmentsFromZwo(doc);

  const ftpUsed =
    Number.isFinite(ftpFromTag) && ftpFromTag > 0
      ? ftpFromTag
      : DEFAULT_FTP;
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
    canonicalWorkout: {
      source: source || "Unknown",
      sourceURL: "",
      workoutTitle: name,
      rawSegments: segmentsForCategory,
      description: description || "",
    }
  };
}

// --------------------------- Picker helpers ---------------------------

/**
 * Buckets duration into label used by the duration filter.
 */
export function getDurationBucket(durationMin) {
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

/**
 * Adjust kJ to the current FTP (used in picker list sorting).
 */
export function getAdjustedKjForPicker(baseKj, baseFtp, currentFtp) {
  if (
    baseKj == null ||
    !Number.isFinite(baseFtp) ||
    !Number.isFinite(currentFtp)
  ) {
    return baseKj;
  }
  if (baseFtp <= 0) return workout.baseKj;
  return baseKj * (currentFtp / baseFtp);
}

