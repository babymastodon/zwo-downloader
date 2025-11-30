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

  // Hard safety limits to avoid runaway durations / repeats
  const MAX_SEGMENT_DURATION_SEC = 12 * 3600;   // 12 hours per segment
  const MAX_WORKOUT_DURATION_SEC = 24 * 3600;   // 24 hours total workout
  const MAX_INTERVAL_REPEATS = 500;             // sanity cap on repeats

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

  descField.textarea.addEventListener("input", () => {
    autoGrowTextarea(descField.textarea);
  });

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

  // URL import card
  const importCard = document.createElement("div");
  importCard.className = "wb-card wb-code-card";
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
    "Paste a TrainerDay / WhatsOnZwift workout URL";
  urlInput.className = "wb-url-input";

  const urlBtn = document.createElement("button");
  urlBtn.type = "button";
  urlBtn.className = "picker-add-btn";

  // SVG icon (currentColor stroke)
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.classList.add("wb-code-icon");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");

  // Feather-style "download/import" arrow
  const path1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path1.setAttribute("d", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4");

  const path2 = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  path2.setAttribute("points", "7 10 12 15 17 10");

  const path3 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  path3.setAttribute("x1", "12");
  path3.setAttribute("y1", "3");
  path3.setAttribute("x2", "12");
  path3.setAttribute("y2", "15");

  icon.appendChild(path1);
  icon.appendChild(path2);
  icon.appendChild(path3);

  // Add text inside a <span>
  const textSpan = document.createElement("span");
  textSpan.textContent = "Import";

  // Put icon + text inside button
  urlBtn.appendChild(icon);
  urlBtn.appendChild(textSpan);

  // Assemble UI
  urlRow.appendChild(urlInput);
  urlRow.appendChild(urlBtn);
  urlSection.appendChild(urlTitle);
  urlSection.appendChild(urlRow);

  // Error row
  const errorRow = document.createElement("div");
  errorRow.className = "wb-code-error-row";

  const errorLabel = document.createElement("div");
  errorLabel.className = "wb-code-error-label";
  errorLabel.textContent = "Status:";

  const errorMessage = document.createElement("div");
  errorMessage.className = "wb-code-error-message wb-code-error-message--neutral";
  errorMessage.textContent = "Not checked yet.";

  errorRow.appendChild(errorLabel);
  errorRow.appendChild(errorMessage);

  importCard.appendChild(urlSection);
  importCard.appendChild(errorRow);

  colCode.appendChild(importCard);


  // Toolbar with ZWO elements
  const toolbar = document.createElement("div");
  toolbar.className = "wb-code-toolbar";

  const toolbarLabel = document.createElement("div");
  toolbarLabel.className = "wb-code-toolbar-label";
  toolbarLabel.textContent = "Blocks";

  const toolbarButtons = document.createElement("div");
  toolbarButtons.className = "wb-code-toolbar-buttons";

  const buttonSpecs = [
    {
      key: "steady",
      label: "SteadyState",
      snippet: '<SteadyState Duration="300" Power="0.75" />',
      icon: "steady",
    },
    {
      key: "warmup",
      label: "Warmup",
      snippet:
        '<Warmup Duration="600" PowerLow="0.50" PowerHigh="0.75" />',
      icon: "rampUp",
    },
    {
      key: "cooldown",
      label: "Cooldown",
      snippet:
        '<Cooldown Duration="600" PowerLow="0.75" PowerHigh="0.50" />',
      icon: "rampDown",
    },
    {
      key: "intervals",
      label: "IntervalsT",
      snippet:
        '<IntervalsT Repeat="3" OnDuration="300" OffDuration="180" OnPower="0.90" OffPower="0.50" />',
      icon: "intervals",
    },
  ];

  buttonSpecs.forEach((spec) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wb-code-insert-btn";
    btn.dataset.key = spec.key;

    // Icon + label
    if (spec.icon) {
      const iconEl = createWorkoutElementIcon(spec.icon);
      btn.appendChild(iconEl);
    }

    const labelSpan = document.createElement("span");
    labelSpan.textContent = spec.label;
    btn.appendChild(labelSpan);

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

  // Wrapper + highlight layer + textarea
  const codeWrapper = document.createElement("div");
  codeWrapper.className = "wb-code-wrapper";

  const codeHighlights = document.createElement("div");
  codeHighlights.className = "wb-code-highlights";

  const codeTextarea = document.createElement("textarea");
  codeTextarea.className = "wb-code-textarea";
  codeTextarea.spellcheck = false;
  codeTextarea.rows = 18;
  codeTextarea.placeholder =
    'Click the above buttons to add workout blocks.';
  codeTextarea.addEventListener("input", () => autoGrowTextarea(codeTextarea));
  codeTextarea.addEventListener("scroll", () => {
    codeHighlights.scrollTop = codeTextarea.scrollTop;
    codeHighlights.scrollLeft = codeTextarea.scrollLeft;
  });

  codeWrapper.appendChild(codeHighlights);
  codeWrapper.appendChild(codeTextarea);
  textareaWrapper.appendChild(codeWrapper);

  codeCard.appendChild(toolbar);
  codeCard.appendChild(textareaWrapper);

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
  let isUrlImportInProgress = false;

  async function runUrlImport() {
    const url = (urlInput.value || "").trim();
    if (!url || isUrlImportInProgress) return;

    isUrlImportInProgress = true;
    errorMessage.textContent = "Importing workout…";
    errorMessage.className =
      "wb-code-error-message wb-code-error-message--neutral";

    try {
      const {snippet, error} = await importFromUrl(url);

      if (error || !snippet) {
        console.warn("[WorkoutBuilder] Import error:", error);
        errorMessage.textContent =
          (error && error.message) ||
          "Could not import workout from this URL yet.";
        errorMessage.className =
          "wb-code-error-message wb-code-error-message--error";
        return;
      }

      codeTextarea.value = snippet.trim();
      handleAnyChange();
      refreshLayout();
    } catch (err) {
      console.error("[WorkoutBuilder] Import failed:", err);
      errorMessage.textContent =
        "Import failed. See console for details.";
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--error";
    } finally {
      isUrlImportInProgress = false;
    }
  }

  // Button click -> import
  urlBtn.addEventListener("click", (e) => {
    e.preventDefault();
    runUrlImport();
  });

  // Press Enter in URL input -> import
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runUrlImport();
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
    refreshLayout();
  })();

  // ---------- Public API ----------

  function refreshLayout() {
    autoGrowTextarea(descField.textarea);
    autoGrowTextarea(codeTextarea);
  }

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

  function clearState() {
    // Clear UI fields
    nameField.input.value = "";
    sourceField.input.value = "";
    descField.textarea.value = "";
    codeTextarea.value = "";

    // Recompute everything & persist empty state
    setDefaultSnippet();
    handleAnyChange();
    refreshLayout();
  }

  function loadFromWorkoutMeta(meta) {
    if (!meta || typeof meta !== "object") return;

    // Metadata
    nameField.input.value = meta.name || "";
    sourceField.input.value = meta.source || "";
    descField.textarea.value = meta.description || "";

    // Code:
    // Prefer a raw snippet if you ever store one; otherwise rebuild from segmentsForMetrics.
    if (meta.rawSnippet && meta.rawSnippet.trim()) {
      codeTextarea.value = meta.rawSnippet;
    } else if (Array.isArray(meta.segmentsForMetrics) && meta.segmentsForMetrics.length) {
      codeTextarea.value = segmentsToZwoSnippet(segmentsToRaw(
        meta.segmentsForMetrics
      ));
    } else {
      codeTextarea.value = "";
    }

    // Recompute metrics, errors, stats, and persist
    handleAnyChange();
  }

  function validateForSave() {
    // Keep currentErrors / metrics up to date
    handleAnyChange();

    const name = (nameField.input.value || "").trim();
    const source = (sourceField.input.value || "").trim();
    const desc = (descField.textarea.value || "").trim();
    const snippet = (codeTextarea.value || "").trim();

    // Clear previous highlights
    nameField.input.classList.remove("wb-input-error");
    sourceField.input.classList.remove("wb-input-error");
    descField.textarea.classList.remove("wb-input-error");
    codeTextarea.classList.remove("wb-input-error");

    /** @type {{field: string, message: string}[]} */
    const errors = [];

    if (!name) {
      errors.push({field: "name", message: "Name is required."});
    }

    if (!source) {
      errors.push({
        field: "source",
        message: "Author / Source is required.",
      });
    }

    if (!desc) {
      errors.push({
        field: "description",
        message: "Description is required.",
      });
    }

    if (!snippet) {
      errors.push({
        field: "code",
        message: "Workout code is empty.",
      });
    }

    // Syntax errors from parsing
    if (currentErrors && currentErrors.length) {
      const firstSyntax = currentErrors[0];
      errors.push({
        field: "code",
        message: firstSyntax.message || "Fix syntax errors before saving.",
      });
    }

    const hasErrors = errors.length > 0;

    // Highlight all fields with errors
    for (const err of errors) {
      switch (err.field) {
        case "name":
          nameField.input.classList.add("wb-input-error");
          break;
        case "source":
          sourceField.input.classList.add("wb-input-error");
          break;
        case "description":
          descField.textarea.classList.add("wb-input-error");
          break;
        case "code":
          codeTextarea.classList.add("wb-input-error");
          break;
      }
    }

    // Update the bottom error message with the FIRST error only
    if (hasErrors) {
      const first = errors[0];
      errorMessage.textContent = first.message;
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--error";
    } else {
      // All good -> show “ok” styling or clear
      errorMessage.textContent = "Ready to save.";
      errorMessage.className =
        "wb-code-error-message wb-code-error-message--ok";
    }

    return {
      ok: !hasErrors,
      errors: errors.map((e) => e.message),
    };
  }

  function setDefaultSnippet() {
    codeTextarea.value =
      '<Warmup Duration="600" PowerLow="0.50" PowerHigh="0.75" />\n' +
      '<SteadyState Duration="1200" Power="0.85" />\n' +
      '<Cooldown Duration="600" PowerLow="0.75" PowerHigh="0.50" />';
  }

  function segmentsToRaw(segments) {
    return segments.map(s => {
      const minutes = s.durationSec / 60;          // 60 sec → 1
      const startPct = s.pStartRel * 100;          // 0.40 → 40
      const endPct = s.pEndRel * 100;              // 0.40 → 40
      return [minutes, startPct, endPct];
    });
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
      currentCategory = inferCategoryFromSegments(segmentsToRaw(currentSegments));
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
    updateErrorHighlights();

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

      const {attrs, hasGarbage} = parseAttributes(attrsText);

      if (hasGarbage) {
        // There was stray text inside the tag (e.g. '?**')
        errors.push({
          start: startIdx,
          end: endIdx,
          message:
            "Malformed element: unexpected text or tokens inside element.",
        });
        // Skip creating segments from this element
        lastIndex = endIdx;
        continue;
      }

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
    let hasGarbage = false;

    const attrRegex =
      /([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*"([^"]*)"/g;

    let m;
    let lastIndex = 0;

    while ((m = attrRegex.exec(attrText)) !== null) {
      // Anything between the end of the previous match and this one?
      if (m.index > lastIndex) {
        const between = attrText.slice(lastIndex, m.index);
        if (between.trim().length > 0) {
          // Non-whitespace we don't understand → garbage
          hasGarbage = true;
        }
      }

      attrs[m[1]] = m[2];
      lastIndex = attrRegex.lastIndex;
    }

    // Trailing text after the last attribute
    const trailing = attrText.slice(lastIndex);
    if (trailing.trim().length > 0) {
      hasGarbage = true;
    }

    return {attrs, hasGarbage};
  }

  function handleSteady(attrs, segments, errors, start, end) {
    const durStr = attrs.Duration;
    const pStr = attrs.Power;
    const duration = durStr != null ? Number(durStr) : NaN;
    const power = pStr != null ? Number(pStr) : NaN;

    if (!validateDuration(duration, "SteadyState", start, end, errors)) {
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

    if (!validateDuration(duration, tagName, start, end, errors)) {
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

  function validateDuration(duration, tagName, start, end, errors) {
    if (!Number.isFinite(duration) || duration <= 0) {
      errors.push({
        start,
        end,
        message: `${tagName} must have a positive numeric Duration (seconds).`,
      });
      return false;
    }
    if (duration > MAX_SEGMENT_DURATION_SEC) {
      errors.push({
        start,
        end,
        message: `${tagName} Duration is unrealistically large (max ${MAX_SEGMENT_DURATION_SEC} seconds).`,
      });
      return false;
    }
    return true;
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

    if (!Number.isFinite(repeat) || repeat <= 0 || repeat > MAX_INTERVAL_REPEATS) {
      errors.push({
        start,
        end,
        message: `IntervalsT must have Repeat as a positive integer (max ${MAX_INTERVAL_REPEATS}).`,
      });
      return;
    }

    if (!validateDuration(onDur, "IntervalsT OnDuration", start, end, errors)) {
      return;
    }
    if (!validateDuration(offDur, "IntervalsT OffDuration", start, end, errors)) {
      return;
    }

    // Also guard the total workout time this block would create
    const totalBlockSec = repeat * (onDur + offDur);
    if (!Number.isFinite(totalBlockSec) || totalBlockSec > MAX_WORKOUT_DURATION_SEC) {
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

  // ---------- URL import (using page URL, not a .zwo URL) ----------

  async function importFromUrl(inputUrl) {
    let url;
    try {
      url = new URL(inputUrl);
    } catch {
      return {
        snippet: null,
        error: {
          type: "invalidUrl",
          message: "That doesn’t look like a valid URL.",
        },
      };
    }

    if (url.host.includes("trainerday.com")) {
      return importFromTrainerDay(url);
    }

    if (url.host.includes("whatsonzwift.com")) {
      return importFromWhatsOnZwift(url);
    }

    console.info(
      "[WorkoutBuilder] Import-from-URL currently only implemented for TrainerDay and WhatsOnZwift; got",
      url.host,
    );
    return {
      snippet: null,
      error: {
        type: "unsupportedHost",
        message:
          "This URL is not from a supported workout site (TrainerDay or WhatsOnZwift).",
      },
    };
  }

  // segments: [minutes, startPct, endPct?]
  // Detects repeated steady on/off pairs and emits IntervalsT when possible.
  function segmentsToZwoSnippet(segments) {
    if (!Array.isArray(segments) || !segments.length) return "";

    const blocks = [];

    // ---------- 1) segments -> blocks ----------
    for (const seg of segments) {
      if (!Array.isArray(seg) || seg.length < 2) continue;

      const minutes = Number(seg[0]);
      const startPct = Number(seg[1]);
      const endPct = seg.length > 2 && seg[2] != null ? Number(seg[2]) : startPct;

      if (
        !Number.isFinite(minutes) ||
        minutes <= 0 ||
        !Number.isFinite(startPct) ||
        !Number.isFinite(endPct)
      ) {
        continue;
      }

      const durationSec = minutes * 60;
      const pStartRel = startPct / 100;
      const pEndRel = endPct / 100;

      if (durationSec <= 0) continue;

      if (Math.abs(pStartRel - pEndRel) < 1e-6) {
        // steady
        blocks.push({
          kind: "steady",
          durationSec,
          powerRel: pStartRel,
        });
      } else if (pEndRel > pStartRel) {
        // ramp up
        blocks.push({
          kind: "rampUp",
          durationSec,
          powerLowRel: pStartRel,
          powerHighRel: pEndRel,
        });
      } else {
        // ramp down
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
    const DUR_TOL = 1;      // seconds
    const PWR_TOL = 0.01;   // relative FTP (0.01 = 1%)

    let i = 0;

    while (i < blocks.length) {
      // Try to detect repeated steady on/off pairs → IntervalsT
      if (i + 3 < blocks.length) {
        const firstA = blocks[i];
        const firstB = blocks[i + 1];

        if (firstA.kind === "steady" && firstB.kind === "steady") {
          let repeat = 1;
          let j = i + 2;

          // Scan forward for more identical A/B pairs
          while (j + 1 < blocks.length) {
            const nextA = blocks[j];
            const nextB = blocks[j + 1];

            if (
              nextA.kind !== "steady" ||
              nextB.kind !== "steady" ||
              !blocksSimilarSteady(firstA, nextA, DUR_TOL, PWR_TOL) ||
              !blocksSimilarSteady(firstB, nextB, DUR_TOL, PWR_TOL)
            ) {
              break;
            }

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
              ` OnPower="${onPow}" OffPower="${offPow}" />`,
            );

            i += repeat * 2;
            continue;
          }
        }
      }

      // Fallback: single block -> SteadyState / Warmup / Cooldown
      const b = blocks[i];

      if (b.kind === "steady") {
        lines.push(
          `<SteadyState Duration="${Math.round(
            b.durationSec,
          )}" Power="${b.powerRel.toFixed(2)}" />`,
        );
      } else if (b.kind === "rampUp") {
        lines.push(
          `<Warmup Duration="${Math.round(
            b.durationSec,
          )}" PowerLow="${b.powerLowRel.toFixed(
            2,
          )}" PowerHigh="${b.powerHighRel.toFixed(2)}" />`,
        );
      } else if (b.kind === "rampDown") {
        lines.push(
          `<Cooldown Duration="${Math.round(
            b.durationSec,
          )}" PowerLow="${b.powerLowRel.toFixed(
            2,
          )}" PowerHigh="${b.powerHighRel.toFixed(2)}" />`,
        );
      }

      i++;
    }

    return lines.join("\n");
  }

  // Helper: compare steady blocks
  function blocksSimilarSteady(a, b, durTolSec, pwrTol) {
    if (a.kind !== "steady" || b.kind !== "steady") return false;
    const durDiff = Math.abs(a.durationSec - b.durationSec);
    const pDiff = Math.abs(a.powerRel - b.powerRel);
    return durDiff <= durTolSec && pDiff <= pwrTol;
  }

  // ---------- TrainerDay ----------

  async function importFromTrainerDay(url) {
    try {
      const slugMatch = url.pathname.match(/\/workouts\/([^/?#]+)/);
      if (!slugMatch) {
        return {
          snippet: null,
          error: {
            type: "invalidTrainerDayPath",
            message: "This TrainerDay URL does not look like a workout page.",
          },
        };
      }
      const slug = slugMatch[1];

      const apiUrl = `https://app.api.trainerday.com/api/workouts/bySlug/${encodeURIComponent(
        slug,
      )}`;

      const res = await fetch(apiUrl, {credentials: "omit"});
      if (!res.ok) {
        return {
          snippet: null,
          error: {
            type: "network",
            message: `TrainerDay request failed (HTTP ${res.status}).`,
          },
        };
      }

      const json = await res.json();
      if (!Array.isArray(json.segments) || !json.segments.length) {
        return {
          snippet: null,
          error: {
            type: "noSegments",
            message: "TrainerDay workout has no segments to import.",
          },
        };
      }

      const segments = json.segments.map((seg) => {
        const minutes = Number(seg[0]);
        const startPct = Number(seg[1]);
        const endPct =
          seg.length > 2 && seg[2] != null ? Number(seg[2]) : startPct;
        return [minutes, startPct, endPct];
      });

      if (json.title) nameField.input.value = json.title;
      if (json.description) descField.textarea.value = json.description;
      sourceField.input.value = "TrainerDay";

      const snippet = segmentsToZwoSnippet(segments);
      if (!snippet) {
        return {
          snippet: null,
          error: {
            type: "emptySnippet",
            message: "TrainerDay workout could not be converted to ZWO elements.",
          },
        };
      }

      return {snippet, error: null};
    } catch (err) {
      console.error("[WorkoutBuilder] TrainerDay import error:", err);
      return {
        snippet: null,
        error: {
          type: "exception",
          message: "Import from TrainerDay failed. See console for details.",
        },
      };
    }
  }

  // ---------- Whats On Zwift ----------
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

  // Returns array of { minutes, startPct, endPct }
  function extractWozSegmentsFromDoc(doc) {
    const container = doc.querySelector("div.order-2");
    if (!container) {
      console.warn("[WorkoutBuilder][WhatsOnZwift] order-2 container not found.");
      return [];
    }

    const bars = Array.from(container.querySelectorAll(".textbar"));
    const segments = [];

    for (const bar of bars) {
      const text = (bar.textContent || "").replace(/\s+/g, " ").trim();
      const powSpans = bar.querySelectorAll(
        'span[data-unit="relpow"][data-value]',
      );

      // --- Intervals like "5x 4min @ 72% FTP, 2min @ 52% FTP" / "5x 30sec ..." ---
      const repMatch = text.match(/(\d+)\s*x\b/i);
      if (repMatch && powSpans.length >= 2) {
        const reps = parseInt(repMatch[1], 10);
        if (Number.isFinite(reps) && reps > 0) {
          const durMatches = Array.from(
            text.matchAll(/(\d+(?:\.\d+)?)\s*(min|sec)/gi),
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
                });
                segments.push({
                  minutes: offMinutes,
                  startPct: pOff,
                  endPct: pOff,
                });
              }
              continue; // handled this bar
            }
          }
        }
      }

      // --- Regular single-interval bars (including ramps & seconds) ---

      // Duration: minutes first, then seconds
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

      if (powSpans.length === 1) {
        const pct = Number(powSpans[0].getAttribute("data-value"));
        if (!Number.isFinite(pct)) continue;
        segments.push({
          minutes,
          startPct: pct,
          endPct: pct,
        });
      } else if (powSpans.length >= 2) {
        const pctLow = Number(powSpans[0].getAttribute("data-value"));
        const pctHigh = Number(powSpans[1].getAttribute("data-value"));
        if (!Number.isFinite(pctLow) || !Number.isFinite(pctHigh)) continue;
        segments.push({
          minutes,
          startPct: pctLow,
          endPct: pctHigh,
        });
      }
    }

    return segments;
  }

  async function importFromWhatsOnZwift(url) {
    try {
      const res = await fetch(url.toString(), {credentials: "omit"});
      if (!res.ok) {
        return {
          snippet: null,
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
        console.warn(
          "[WorkoutBuilder][WhatsOnZwift] No segments extracted from DOM.",
        );
        return {
          snippet: null,
          error: {
            type: "noSegments",
            message:
              "Could not find any intervals on this WhatsOnZwift workout page.",
          },
        };
      }

      const segments = wozSegments.map((s) => [
        s.minutes,
        s.startPct,
        s.endPct,
      ]);

      const title = extractWozTitleFromDoc(doc);
      const description = extractWozDescriptionFromDoc(doc);

      if (title) nameField.input.value = title;
      if (description) descField.textarea.value = description;
      sourceField.input.value = "WhatsOnZwift";

      const snippet = segmentsToZwoSnippet(segments);
      if (!snippet) {
        return {
          snippet: null,
          error: {
            type: "emptySnippet",
            message:
              "WhatsOnZwift workout could not be converted to ZWO elements.",
          },
        };
      }

      return {snippet, error: null};
    } catch (err) {
      console.error("[WorkoutBuilder] WhatsOnZwift import error:", err);
      return {
        snippet: null,
        error: {
          type: "exception",
          message: "Import from WhatsOnZwift failed. See console for details.",
        },
      };
    }
  }

  // ---------- Small DOM helpers ----------

  function escapeHtml(str) {
    return (str || "").replace(/[&<>"]/g, (c) => {
      switch (c) {
        case "&": return "&amp;";
        case "<": return "&lt;";
        case ">": return "&gt;";
        default: return c;
      }
    });
  }

  function updateErrorHighlights() {
    if (!codeHighlights) return;

    const text = codeTextarea.value || "";
    const lines = text.split("\n");
    const lineCount = lines.length;

    // No errors: just mirror text so height stays in sync
    if (!currentErrors.length) {
      const html = lines
        .map((line) => `<div>${escapeHtml(line) || " "}</div>`)
        .join("");
      codeHighlights.innerHTML = html;
      return;
    }

    // Build a table of where each line starts (by char index)
    const lineOffsets = [];
    let offset = 0;
    for (let i = 0; i < lineCount; i += 1) {
      lineOffsets.push(offset);
      // +1 for the newline char that was split away
      offset += lines[i].length + 1;
    }

    function indexToLine(idx) {
      if (!Number.isFinite(idx)) return 0;
      if (idx <= 0) return 0;
      if (idx >= text.length) return lineCount - 1;

      // Simple linear search is fine here (text is small),
      // but you could do binary search if you ever need it faster.
      for (let i = 0; i < lineOffsets.length; i += 1) {
        const start = lineOffsets[i];
        const nextStart = i + 1 < lineOffsets.length ? lineOffsets[i + 1] : Infinity;
        if (idx >= start && idx < nextStart) {
          return i;
        }
      }
      return lineCount - 1;
    }

    const errorLines = new Set();

    for (const err of currentErrors) {
      let start = Number.isFinite(err.start) ? err.start : 0;
      let end = Number.isFinite(err.end) ? err.end : start;

      // Clamp to valid range of characters
      start = Math.max(0, Math.min(start, text.length));
      end = Math.max(start, Math.min(end, text.length));

      const startLine = indexToLine(start);
      const endLine = indexToLine(end);

      // Clamp line indices defensively too
      const s = Math.max(0, Math.min(startLine, lineCount - 1));
      const e = Math.max(s, Math.min(endLine, lineCount - 1));

      for (let i = s; i <= e; i += 1) {
        errorLines.add(i);
      }
    }

    const html = lines
      .map((line, idx) => {
        const safe = escapeHtml(line) || " ";
        if (errorLines.has(idx)) {
          return `<div class="wb-highlight-line">${safe}</div>`;
        }
        return `<div>${safe}</div>`;
      })
      .join("");

    codeHighlights.innerHTML = html;
  }

  function createWorkoutElementIcon(kind) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.classList.add("wb-code-icon");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "currentColor");

    switch (kind) {
      case "steady":
        // Flat block
        path.setAttribute("d", "M4 14h16v6H4z");
        break;

      case "rampUp":
        // Warmup: rising filled ramp (low left → high right)
        path.setAttribute(
          "d",
          "M4 20 L20 20 20 8 4 16 Z"
        );
        break;

      case "rampDown":
        // Cooldown: descending filled ramp (high left → low right)
        path.setAttribute(
          "d",
          "M4 8 L20 16 20 20 4 20 Z"
        );
        break;

      case "intervals":
      default:
        // Repeated blocks (ON/OFF pattern)
        path.setAttribute(
          "d",
          "M4 20h4v-8H4zm6 0h4v-14h-4zm6 0h4v-10h-4z"
        );
        break;
    }

    svg.appendChild(path);
    return svg;
  }

  function autoGrowTextarea(el) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

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

    autoGrowTextarea(textarea);
  }

  // Expose minimal API if needed later (currently we only use side effects)
  return {
    getState,
    clearState,
    refreshLayout,
    validateForSave,
    loadFromWorkoutMeta,
  };
}

