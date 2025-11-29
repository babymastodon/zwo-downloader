// workout-builder.js

import {renderMiniWorkoutGraph} from "./workout-chart.js";
import {
  computeMetricsFromSegments,
  inferCategoryFromSegments,
} from "./workout-metrics.js";
import {
  saveWorkoutBuilderState,
  loadWorkoutBuilderState,
} from "./storage.js";

/**
 * @typedef WorkoutBuilderOptions
 * @property {HTMLElement} rootEl
 * @property {() => number} getCurrentFtp
 */

export function createWorkoutBuilder(options) {
  const {rootEl, getCurrentFtp} = options;
  if (!rootEl) throw new Error("[WorkoutBuilder] rootEl is required");

  // ---------- State ----------
  /** @type {Array<{durationSec:number,pStartRel:number,pEndRel:number}>} */
  let currentSegments = [];
  let currentErrors = [];
  let currentMetrics = null;
  let currentCategory = null;

  // ---------- Layout ----------
  rootEl.innerHTML = "";
  rootEl.classList.add("workout-builder-root");

  const wrapper = document.createElement("div");
  wrapper.className = "workout-builder";

  const body = document.createElement("div");
  body.className = "workout-builder-body";

  const colMeta = document.createElement("section");
  colMeta.className = "workout-builder-col wb-col-meta";

  const colCode = document.createElement("section");
  colCode.className = "workout-builder-col wb-col-code";

  body.appendChild(colMeta);
  body.appendChild(colCode);
  wrapper.appendChild(body);
  rootEl.appendChild(wrapper);

  // ---------- Column 1: metadata + stats + chart ----------

  // Metadata card
  const metaCard = document.createElement("div");
  metaCard.className = "wb-card wb-meta-card";

  const metaFields = document.createElement("div");
  metaFields.className = "wb-meta-fields";

  const nameField = createLabeledInput("Name");
  const sourceField = createLabeledInput("Author / Source");
  const descField = createLabeledTextarea("Description");

  metaFields.appendChild(nameField.wrapper);
  metaFields.appendChild(sourceField.wrapper);
  metaFields.appendChild(descField.wrapper);

  // Stats
  const statsRow = document.createElement("div");
  statsRow.className = "wb-stats-row";

  const statTss = createStatChip("TSS");
  const statIf = createStatChip("IF");
  const statKj = createStatChip("kJ");
  const statDuration = createStatChip("Duration");
  const statFtp = createStatChip("FTP");
  const statCategory = createStatChip("Category");

  [
    statTss.el,
    statIf.el,
    statKj.el,
    statDuration.el,
    statFtp.el,
    statCategory.el,
  ].forEach((el) => statsRow.appendChild(el));

  metaCard.appendChild(metaFields);
  metaCard.appendChild(statsRow);

  // Chart card
  const chartCard = document.createElement("div");
  chartCard.className = "wb-card wb-chart-card";

  const chartTitle = document.createElement("div");
  chartTitle.className = "wb-section-title";
  chartTitle.textContent = "Workout preview";

  const chartContainer = document.createElement("div");
  chartContainer.className = "wb-chart-container";

  const chartMiniHost = document.createElement("div");
  chartMiniHost.className = "wb-chart-mini-host";

  chartContainer.appendChild(chartMiniHost);
  chartCard.appendChild(chartTitle);
  chartCard.appendChild(chartContainer);

  colMeta.appendChild(metaCard);
  colMeta.appendChild(chartCard);

  // ---------- Column 2: ZWO editor + error + URL import ----------

  const codeCard = document.createElement("div");
  codeCard.className = "wb-card wb-code-card";

  // Toolbar with ZWO elements
  const toolbar = document.createElement("div");
  toolbar.className = "wb-code-toolbar";

  const toolbarLabel = document.createElement("div");
  toolbarLabel.className = "wb-code-toolbar-label";
  toolbarLabel.textContent = "ZWO workout elements";

  const toolbarButtons = document.createElement("div");
  toolbarButtons.className = "wb-code-toolbar-buttons";

  const buttonSpecs = [
    {
      key: "steady",
      label: "SteadyState",
      snippet: '<SteadyState Duration="300" Power="0.75" />',
    },
    {
      key: "warmup",
      label: "Warmup",
      snippet:
        '<Warmup Duration="600" PowerLow="0.50" PowerHigh="0.75" />',
    },
    {
      key: "cooldown",
      label: "Cooldown",
      snippet:
        '<Cooldown Duration="600" PowerLow="0.75" PowerHigh="0.50" />',
    },
    {
      key: "intervals",
      label: "IntervalsT",
      snippet:
        '<IntervalsT Repeat="3" OnDuration="300" OffDuration="180" OnPower="0.90" OffPower="0.50" />',
    },
  ];

  buttonSpecs.forEach((spec) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wb-code-insert-btn";
    btn.dataset.key = spec.key;
    btn.textContent = spec.label;
    btn.addEventListener("click", () => {
      insertSnippetAtCursor(codeTextarea, spec.snippet);
      handleAnyChange();
    });
    toolbarButtons.appendChild(btn);
  });

  toolbar.appendChild(toolbarLabel);
  toolbar.appendChild(toolbarButtons);

  // Textarea
  const textareaWrapper = document.createElement("div");
  textareaWrapper.className = "wb-code-textarea-wrapper";

  const codeTextarea = document.createElement("textarea");
  codeTextarea.className = "wb-code-textarea";
  codeTextarea.spellcheck = false;
  codeTextarea.rows = 18;
  codeTextarea.placeholder =
    '<SteadyState Duration="300" Power="0.75" />\n<SteadyState Duration="300" Power="0.85" />\n<Cooldown Duration="600" PowerLow="0.75" PowerHigh="0.50" />';

  textareaWrapper.appendChild(codeTextarea);

  // Error row
  const errorRow = document.createElement("div");
  errorRow.className = "wb-code-error-row";

  const errorLabel = document.createElement("div");
  errorLabel.className = "wb-code-error-label";
  errorLabel.textContent = "Syntax:";

  const errorMessage = document.createElement("div");
  errorMessage.className = "wb-code-error-message wb-code-error-message--neutral";
  errorMessage.textContent = "Not checked yet.";

  errorRow.appendChild(errorLabel);
  errorRow.appendChild(errorMessage);

  // URL import under textarea
  const urlSection = document.createElement("div");
  urlSection.className = "wb-url-section";

  const urlTitle = document.createElement("div");
  urlTitle.className = "wb-section-title";
  urlTitle.textContent = "Import from URL";

  const urlRow = document.createElement("div");
  urlRow.className = "wb-url-row";

  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.placeholder =
    "Paste a TrainerDay / TrainerRoad / WhatsOnZwift workout URL";
  urlInput.className = "wb-url-input";

  const urlBtn = document.createElement("button");
  urlBtn.type = "button";
  urlBtn.className = "wb-url-button";
  urlBtn.textContent = "Import";

  urlRow.appendChild(urlInput);
  urlRow.appendChild(urlBtn);
  urlSection.appendChild(urlTitle);
  urlSection.appendChild(urlRow);

  codeCard.appendChild(toolbar);
  codeCard.appendChild(textareaWrapper);
  codeCard.appendChild(errorRow);
  codeCard.appendChild(urlSection);

  colCode.appendChild(codeCard);

  // ---------- Events ----------

  // Text changes
  codeTextarea.addEventListener("input", () => {
    handleAnyChange();
  });
  codeTextarea.addEventListener("click", () => {
    updateErrorMessageForCaret();
  });
  codeTextarea.addEventListener("keyup", () => {
    updateErrorMessageForCaret();
  });

  // Metadata changes
  [nameField.input, sourceField.input, descField.textarea].forEach((el) => {
    el.addEventListener("input", () => {
      handleAnyChange({skipParse: true});
    });
  });

  // URL import
  urlBtn.addEventListener("click", async () => {
    const url = (urlInput.value || "").trim();
    if (!url) return;
    try {
      errorMessage.textContent = "Importing workout…";
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--neutral";
      const snippet = await importFromUrl(url);
      if (!snippet) {
        errorMessage.textContent =
          "Could not import workout from this URL yet.";
        errorMessage.className =
          "wb-code-error-message wb-code-error-message--error";
        return;
      }
      codeTextarea.value = snippet.trim();
      handleAnyChange();
    } catch (err) {
      console.error("[WorkoutBuilder] Import failed:", err);
      errorMessage.textContent =
        "Import failed. See console for details.";
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--error";
    }
  });

  // ---------- Init: restore from storage or default ----------

  (async () => {
    try {
      if (typeof loadWorkoutBuilderState === "function") {
        const saved = await loadWorkoutBuilderState();
        if (saved && typeof saved === "object") {
          if (saved.name) nameField.input.value = saved.name;
          if (saved.source) sourceField.input.value = saved.source;
          if (saved.description) descField.textarea.value = saved.description;
          if (saved.rawSnippet) {
            codeTextarea.value = saved.rawSnippet;
          }
        }
      }
    } catch (e) {
      console.warn("[WorkoutBuilder] Failed to load saved state:", e);
    }
    if (!codeTextarea.value.trim()) {
      setDefaultSnippet();
    }
    handleAnyChange();
  })();

  // ---------- Public API ----------

  function getState() {
    return {
      name: nameField.input.value || "",
      source: sourceField.input.value || "",
      description: descField.textarea.value || "",
      segments: currentSegments.slice(),
      metrics: currentMetrics,
      category: currentCategory,
      errors: currentErrors.slice(),
      rawSnippet: codeTextarea.value || "",
    };
  }

  function setDefaultSnippet() {
    codeTextarea.value =
      '<Warmup Duration="600" PowerLow="0.50" PowerHigh="0.75" />\n' +
      '<SteadyState Duration="1200" Power="0.85" />\n' +
      '<Cooldown Duration="600" PowerLow="0.75" PowerHigh="0.50" />';
  }

  function handleAnyChange(opts = {}) {
    const {skipParse = false} = opts;

    if (!skipParse) {
      const text = codeTextarea.value || "";
      const parsed = parseWorkoutSnippet(text);
      currentSegments = parsed.segments;
      currentErrors = parsed.errors;
    }

    const ftp = getCurrentFtp() || 0;

    if (currentSegments.length && ftp > 0) {
      currentMetrics = computeMetricsFromSegments(currentSegments, ftp);
      currentCategory = inferCategoryFromSegments(currentSegments);
    } else {
      currentMetrics = {
        totalSec: 0,
        durationMin: 0,
        ifValue: null,
        tss: null,
        kj: null,
        ftp: ftp || null,
      };
      currentCategory = null;
    }

    updateStats();
    renderChart();
    updateErrorStyling();

    // Persist state
    try {
      if (typeof saveWorkoutBuilderState === "function") {
        saveWorkoutBuilderState(getState());
      }
    } catch (e) {
      console.warn("[WorkoutBuilder] Failed to save builder state:", e);
    }
  }

  function updateStats() {
    const ftp = getCurrentFtp() || 0;

    if (!currentMetrics || currentMetrics.totalSec === 0) {
      statTss.value.textContent = "--";
      statIf.value.textContent = "--";
      statKj.value.textContent = "--";
      statDuration.value.textContent = "--";
      statFtp.value.textContent = ftp > 0 ? `${Math.round(ftp)} W` : "--";
      statCategory.value.textContent = currentCategory || "--";
      return;
    }

    statTss.value.textContent =
      currentMetrics.tss != null ? String(Math.round(currentMetrics.tss)) : "--";
    statIf.value.textContent =
      currentMetrics.ifValue != null
        ? currentMetrics.ifValue.toFixed(2)
        : "--";
    statKj.value.textContent =
      currentMetrics.kj != null ? String(Math.round(currentMetrics.kj)) : "--";
    statDuration.value.textContent =
      currentMetrics.durationMin != null
        ? `${Math.round(currentMetrics.durationMin)} min`
        : "--";
    statFtp.value.textContent =
      currentMetrics.ftp != null ? `${Math.round(currentMetrics.ftp)} W` : "--";
    statCategory.value.textContent = currentCategory || "--";
  }

  function renderChart() {
    const ftp = getCurrentFtp() || 0;
    const meta = {
      name:
        (nameField.input.value || "Custom workout").trim() || "Custom workout",
      segmentsForMetrics: currentSegments.slice(),
      totalSec: currentMetrics ? currentMetrics.totalSec : 0,
      ftpFromFile: ftp || null,
      tss: currentMetrics ? currentMetrics.tss : null,
      ifValue: currentMetrics ? currentMetrics.ifValue : null,
      baseKj: currentMetrics ? currentMetrics.kj : null,
      category: currentCategory || null,
    };

    chartMiniHost.innerHTML = "";
    try {
      renderMiniWorkoutGraph(chartMiniHost, meta, ftp);
    } catch (e) {
      console.error("[WorkoutBuilder] Failed to render mini chart:", e);
    }
  }

  function updateErrorStyling() {
    const text = codeTextarea.value || "";

    if (!text.trim()) {
      codeTextarea.classList.remove("wb-has-error");
      errorMessage.textContent = "Empty workout. Add elements to begin.";
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--neutral";
      return;
    }

    if (!currentErrors.length) {
      codeTextarea.classList.remove("wb-has-error");
      errorMessage.textContent = "No syntax errors detected.";
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--ok";
      return;
    }

    codeTextarea.classList.add("wb-has-error");
    const first = currentErrors[0];
    errorMessage.textContent = first.message;
    errorMessage.className =
      "wb-code-error-message wb-code-error-message--error";
    updateErrorMessageForCaret();
  }

  function updateErrorMessageForCaret() {
    if (!currentErrors.length) return;
    const pos = codeTextarea.selectionStart || 0;
    const overlapping = currentErrors.find(
      (err) => pos >= err.start && pos <= err.end,
    );
    if (overlapping) {
      errorMessage.textContent = overlapping.message;
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--error";
    }
  }

  // ---------- Parsing ----------

  function parseWorkoutSnippet(text) {
    const segments = [];
    const errors = [];

    const raw = (text || "")
      .replace(/<\s*workout[^>]*>/gi, "")
      .replace(/<\/\s*workout\s*>/gi, "");
    const trimmed = raw.trim();
    if (!trimmed) return {segments, errors};

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
          message:
            "Unexpected text between elements; only ZWO workout elements are allowed.",
        });
      }

      const attrs = parseAttributes(attrsText);
      switch (tagName) {
        case "SteadyState":
          handleSteady(attrs, segments, errors, startIdx, endIdx);
          break;
        case "Warmup":
        case "Cooldown":
          handleRamp(tagName, attrs, segments, errors, startIdx, endIdx);
          break;
        case "IntervalsT":
          handleIntervals(attrs, segments, errors, startIdx, endIdx);
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

    return {segments, errors};
  }

  function parseAttributes(attrText) {
    const attrs = {};
    const attrRegex =
      /([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = attrRegex.exec(attrText)) !== null) {
      attrs[m[1]] = m[2];
    }
    return attrs;
  }

  function handleSteady(attrs, segments, errors, start, end) {
    const durStr = attrs.Duration;
    const pStr = attrs.Power;
    const duration = durStr != null ? Number(durStr) : NaN;
    const power = pStr != null ? Number(pStr) : NaN;

    if (!Number.isFinite(duration) || duration <= 0) {
      errors.push({
        start,
        end,
        message:
          'SteadyState must have a positive numeric Duration (seconds).',
      });
      return;
    }
    if (!Number.isFinite(power) || power <= 0) {
      errors.push({
        start,
        end,
        message:
          'SteadyState must have a positive numeric Power (relative FTP, e.g. 0.75).',
      });
      return;
    }

    segments.push({
      durationSec: duration,
      pStartRel: power,
      pEndRel: power,
    });
  }

  function handleRamp(tagName, attrs, segments, errors, start, end) {
    const durStr = attrs.Duration;
    const loStr = attrs.PowerLow;
    const hiStr = attrs.PowerHigh;
    const duration = durStr != null ? Number(durStr) : NaN;
    const pLow = loStr != null ? Number(loStr) : NaN;
    const pHigh = hiStr != null ? Number(hiStr) : NaN;

    if (!Number.isFinite(duration) || duration <= 0) {
      errors.push({
        start,
        end,
        message: `${tagName} must have a positive numeric Duration (seconds).`,
      });
      return;
    }
    if (!Number.isFinite(pLow) || !Number.isFinite(pHigh)) {
      errors.push({
        start,
        end,
        message:
          `${tagName} must have PowerLow and PowerHigh as numbers (relative FTP).`,
      });
      return;
    }

    segments.push({
      durationSec: duration,
      pStartRel: pLow,
      pEndRel: pHigh,
    });
  }

  function handleIntervals(attrs, segments, errors, start, end) {
    const repStr = attrs.Repeat;
    const onDurStr = attrs.OnDuration;
    const offDurStr = attrs.OffDuration;
    const onPowStr = attrs.OnPower;
    const offPowStr = attrs.OffPower;

    const repeat = repStr != null ? Number(repStr) : NaN;
    const onDur = onDurStr != null ? Number(onDurStr) : NaN;
    const offDur = offDurStr != null ? Number(offDurStr) : NaN;
    const onPow = onPowStr != null ? Number(onPowStr) : NaN;
    const offPow = offPowStr != null ? Number(offPowStr) : NaN;

    if (!Number.isFinite(repeat) || repeat <= 0) {
      errors.push({
        start,
        end,
        message: "IntervalsT must have Repeat as a positive integer.",
      });
      return;
    }
    if (
      !Number.isFinite(onDur) ||
      onDur <= 0 ||
      !Number.isFinite(offDur) ||
      offDur <= 0
    ) {
      errors.push({
        start,
        end,
        message:
          "IntervalsT must have positive OnDuration and OffDuration (seconds).",
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

  // ---------- URL import (using page URL, not a .zwo URL) ----------

  async function importFromUrl(inputUrl) {
    // NOTE: This is intentionally light and meant to be extended.
    const url = new URL(inputUrl);

    if (url.host.includes("trainerday.com")) {
      // Example: https://app.trainerday.com/workouts/<slug>
      const slugMatch = url.pathname.match(/\/workouts\/([^/?#]+)/);
      if (!slugMatch) return null;
      const slug = slugMatch[1];
      const apiUrl = `https://app.api.trainerday.com/api/workouts/bySlug/${encodeURIComponent(
        slug,
      )}`;
      const res = await fetch(apiUrl, {credentials: "omit"});
      if (!res.ok) throw new Error(`HTTP ${res.status} from TrainerDay API`);
      const json = await res.json();
      if (!Array.isArray(json.segments) || !json.segments.length) {
        return null;
      }

      // segments: [minutes, startPct, endPct?]
      const lines = json.segments.map((seg) => {
        const minutes = Number(seg[0]);
        const startPct = Number(seg[1]);
        const endPct =
          seg.length > 2 && seg[2] != null ? Number(seg[2]) : startPct;
        const durSec = Math.round(minutes * 60);
        const pLow = (startPct / 100).toFixed(2);
        const pHigh = (endPct / 100).toFixed(2);
        if (pLow === pHigh) {
          return `<SteadyState Duration="${durSec}" Power="${pLow}" />`;
        }
        if (pHigh > pLow) {
          return `<Warmup Duration="${durSec}" PowerLow="${pLow}" PowerHigh="${pHigh}" />`;
        }
        return `<Cooldown Duration="${durSec}" PowerLow="${pLow}" PowerHigh="${pHigh}" />`;
      });

      // Also populate metadata if available
      if (json.title) nameField.input.value = json.title;
      if (json.description) descField.textarea.value = json.description;
      sourceField.input.value = "TrainerDay";

      return lines.join("\n");
    }

    // TODO: trainerroad.com, whatsonzwift.com, other sources.
    // Can be implemented by mirroring content.js logic with fetch()
    // + HTML parsing and calling computeMetricsFromSegments / inferCategoryFromSegments.
    console.info(
      "[WorkoutBuilder] Import-from-URL currently only implemented for TrainerDay; got",
      url.host,
    );
    return null;
  }

  // ---------- Small DOM helpers ----------

  function createLabeledInput(labelText) {
    const wrapper = document.createElement("div");
    wrapper.className = "wb-field";

    const label = document.createElement("label");
    label.className = "wb-field-label";
    label.textContent = labelText;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "wb-field-input";

    wrapper.appendChild(label);
    wrapper.appendChild(input);

    return {wrapper, input};
  }

  function createLabeledTextarea(labelText) {
    const wrapper = document.createElement("div");
    wrapper.className = "wb-field";

    const label = document.createElement("label");
    label.className = "wb-field-label";
    label.textContent = labelText;

    const textarea = document.createElement("textarea");
    textarea.rows = 3;
    textarea.className = "wb-field-textarea";

    wrapper.appendChild(label);
    wrapper.appendChild(textarea);

    return {wrapper, textarea};
  }

  function createStatChip(label) {
    const el = document.createElement("div");
    el.className = "wb-stat-chip";
    const labelEl = document.createElement("div");
    labelEl.className = "wb-stat-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("div");
    valueEl.className = "wb-stat-value";
    valueEl.textContent = "--";
    el.appendChild(labelEl);
    el.appendChild(valueEl);
    return {el, value: valueEl};
  }

  function insertSnippetAtCursor(textarea, snippet) {
    const value = textarea.value || "";
    const startSel = textarea.selectionStart || 0;
    const endSel = textarea.selectionEnd || startSel;

    let insertPos = endSel;
    const after = value.slice(endSel);
    const nextGt = after.indexOf(">");
    if (nextGt !== -1) {
      insertPos = endSel + nextGt + 1;
    }

    const beforeText = value.slice(0, insertPos);
    const afterText = value.slice(insertPos);

    const prefix = beforeText && !beforeText.endsWith("\n") ? "\n" : "";
    const suffix = afterText && !afterText.startsWith("\n") ? "\n" : "";

    const newValue = beforeText + prefix + snippet + suffix + afterText;
    textarea.value = newValue;

    const caretPos = (beforeText + prefix + snippet).length;
    textarea.setSelectionRange(caretPos, caretPos);
    textarea.focus();
  }

  // Expose minimal API if needed later (currently we only use side effects)
  return {
    getState,
  };
}

