// workout-picker.js
// Singleton for the ZWO workout picker modal.
//
// Encapsulates:
//   - ZWO directory selection & permission
//   - scanning/parsing .zwo files
//   - metrics-based sorting/filtering
//   - rendering mini workout graphs
//   - keyboard navigation & state persistence

import {
  parseZwo,
  getDurationBucket,
  getAdjustedKjForPicker,
} from "./workout-metrics.js";

import {renderMiniWorkoutGraph} from "./workout-chart.js";

import {
  ensureDirPermission,
  loadPickerState,
  savePickerState,
  saveSelectedWorkout,
  loadZwoDirHandle,
} from "./storage.js";

let instance = null;

/**
 * @typedef PickerConfig
 * @property {HTMLElement} overlay
 * @property {HTMLElement} modal
 * @property {HTMLButtonElement} closeBtn
 * @property {HTMLInputElement} searchInput
 * @property {HTMLSelectElement} categoryFilter
 * @property {HTMLSelectElement} durationFilter
 * @property {HTMLElement} summaryEl
 * @property {HTMLElement} tbody
 * @property {() => number} getCurrentFtp  // called whenever picker needs current FTP
 * @property {(payload: any) => void} onWorkoutSelected // called when user chooses a workout
 */

/**
 * Returns the singleton picker instance (creates it on first call).
 * Safe to call multiple times with the same config.
 */
export function getWorkoutPicker(config) {
  if (!instance) {
    instance = createWorkoutPicker(config);
  }
  return instance;
}

// --------------------------- ZWO scanning ---------------------------

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
    console.error("[WorkoutPicker] Error scanning workouts:", err);
  }
  return workouts;
}

// --------------------------- Singleton factory ---------------------------

function createWorkoutPicker(config) {
  const {
    overlay,
    modal,
    closeBtn,
    searchInput,
    categoryFilter,
    durationFilter,
    summaryEl,
    tbody,
    getCurrentFtp,
    onWorkoutSelected,
  } = config;

  // Internal state
  let pickerWorkouts = [];
  let pickerExpandedKey = null;
  let pickerSortKey = "kjAdj"; // "if", "tss", "kjAdj", "duration", "name"
  let pickerSortDir = "asc";   // "asc" | "desc"
  let isPickerOpen = false;


  // --------------------------- filtering / sorting ---------------------------

  function computeVisiblePickerWorkouts() {
    const searchTerm = (searchInput && searchInput.value || "").toLowerCase();
    const catValue = (categoryFilter && categoryFilter.value) || "";
    const durValue = (durationFilter && durationFilter.value) || "";

    let shown = pickerWorkouts;

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
          (w.description || "").slice(0, 300),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(searchTerm);
      });
    }

    const sortKey = pickerSortKey;
    const dir = pickerSortDir === "asc" ? 1 : -1;
    const currentFtp = getCurrentFtp();

    shown = shown.slice().sort((a, b) => {
      const num = (val) => (Number.isFinite(val) ? val : -Infinity);
      if (sortKey === "kjAdj") {
        return (
          num(getAdjustedKjForPicker(a.baseKj, a.ftpFromFile, currentFtp)) -
          num(getAdjustedKjForPicker(b.baseKj, b.ftpFromFile, currentFtp))
        ) * dir;
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

    return shown;
  }

  function refreshCategoryFilterOptions() {
    if (!categoryFilter) return;

    const valueBefore = categoryFilter.value;
    const cats = Array.from(
      new Set(pickerWorkouts.map((w) => w.category || "Uncategorized"))
    ).sort((a, b) => a.localeCompare(b));

    categoryFilter.innerHTML = "";
    const optAll = document.createElement("option");
    optAll.value = "";
    optAll.textContent = "All categories";
    categoryFilter.appendChild(optAll);

    for (const c of cats) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      categoryFilter.appendChild(opt);
    }

    if (cats.includes(valueBefore)) {
      categoryFilter.value = valueBefore;
    }
  }

  function updateSortHeaderIndicator() {
    if (!modal) return;
    const headers = modal.querySelectorAll("th[data-sort-key]");
    headers.forEach((th) => {
      const key = th.getAttribute("data-sort-key");
      th.classList.remove("sorted-asc", "sorted-desc");
      if (key === pickerSortKey) {
        th.classList.add(pickerSortDir === "asc" ? "sorted-asc" : "sorted-desc");
      }
    });
  }

  // --------------------------- rendering ---------------------------

  function renderWorkoutPickerTable() {
    if (!tbody) return;

    const total = pickerWorkouts.length;

    if (total === 0) {
      tbody.innerHTML = "";
      if (summaryEl) {
        summaryEl.textContent = "No .zwo files found in this folder yet.";
      }
      updateSortHeaderIndicator();
      return;
    }

    const shown = computeVisiblePickerWorkouts();
    const shownCount = shown.length;

    tbody.innerHTML = "";

    if (summaryEl) {
      summaryEl.textContent = `${shownCount} of ${total} workouts shown`;
    }

    const colCount = 7;
    const currentFtp = getCurrentFtp();

    for (const w of shown) {
      const key = w.fileName || w.name;
      const tr = document.createElement("tr");
      tr.className = "picker-row";
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

      const adjKj = getAdjustedKjForPicker(w.baseKj, w.ftpFromFile, currentFtp);
      const tdKj = document.createElement("td");
      tdKj.textContent = adjKj != null ? `${Math.round(adjKj)} kJ` : "";
      tr.appendChild(tdKj);

      tbody.appendChild(tr);

      const expanded = pickerExpandedKey === key;
      if (expanded) {
        const expTr = document.createElement("tr");
        expTr.className = "picker-expanded-row";
        const expTd = document.createElement("td");
        expTd.colSpan = colCount;

        const container = document.createElement("div");
        container.className = "picker-expanded";

        const graphDiv = document.createElement("div");
        graphDiv.className = "picker-graph";

        const detailDiv = document.createElement("div");
        detailDiv.className = "picker-detail";

        const headerRow = document.createElement("div");
        headerRow.style.display = "flex";
        headerRow.style.justifyContent = "flex-end";
        headerRow.style.marginBottom = "4px";

        const selectBtn = document.createElement("button");
        selectBtn.type = "button";
        selectBtn.className = "select-workout-btn";
        selectBtn.textContent = "Select workout";
        selectBtn.title = "Use this workout on the workout page.";
        selectBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          doSelectWorkout(w);
        });

        headerRow.appendChild(selectBtn);
        detailDiv.appendChild(headerRow);

        if (w.description && w.description.trim()) {
          const descHtml = w.description.replace(/\n/g, "<br>");
          const descContainer = document.createElement("div");
          descContainer.innerHTML = descHtml;
          detailDiv.appendChild(descContainer);
        } else {
          const empty = document.createElement("div");
          empty.className = "picker-detail-empty";
          empty.textContent = "(No description)";
          detailDiv.appendChild(empty);
        }

        container.appendChild(graphDiv);
        container.appendChild(detailDiv);
        expTd.appendChild(container);
        expTr.appendChild(expTd);
        tbody.appendChild(expTr);

        renderMiniWorkoutGraph(graphDiv, w, currentFtp);
      }

      tr.addEventListener("click", () => {
        if (pickerExpandedKey === key) {
          pickerExpandedKey = null;
        } else {
          pickerExpandedKey = key;
        }
        renderWorkoutPickerTable();
      });
    }

    updateSortHeaderIndicator();
  }

  function movePickerExpansion(delta) {
    const shown = computeVisiblePickerWorkouts();
    if (!shown.length) return;

    let idx = shown.findIndex((w) => {
      const key = w.fileName || w.name;
      return key === pickerExpandedKey;
    });

    if (idx === -1) {
      idx = delta > 0 ? 0 : shown.length - 1;
    } else {
      idx = (idx + delta + shown.length) % shown.length;
    }

    const next = shown[idx];
    pickerExpandedKey = next.fileName || next.name;
    renderWorkoutPickerTable();
  }

  // --------------------------- sorting / hotkeys wiring ---------------------------

  function setupSorting() {
    if (!modal) return;
    const headerCells = modal.querySelectorAll("th[data-sort-key]");
    headerCells.forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.getAttribute("data-sort-key");
        if (!key) return;
        if (pickerSortKey === key) {
          pickerSortDir = pickerSortDir === "asc" ? "desc" : "asc";
        } else {
          pickerSortKey = key;
          pickerSortDir = key === "kjAdj" ? "asc" : "desc";
        }
        renderWorkoutPickerTable();
        persistPickerState();
      });
    });
    updateSortHeaderIndicator();
  }

  function setupHotkeys() {
    document.addEventListener("keydown", (e) => {
      if (!isPickerOpen) return;

      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      const key = e.key;

      if (key === "ArrowDown" || key === "j" || key === "J") {
        e.preventDefault();
        movePickerExpansion(+1);
        return;
      }

      if (key === "ArrowUp" || key === "k" || key === "K") {
        e.preventDefault();
        movePickerExpansion(-1);
        return;
      }
    });
  }

  // --------------------------- picker state persistence ---------------------------

  async function restorePickerStateIntoControls() {
    const saved = await loadPickerState();
    if (!saved) return;

    if (searchInput) searchInput.value = saved.searchTerm || "";
    if (categoryFilter) categoryFilter.value = saved.category || "";
    if (durationFilter) durationFilter.value = saved.duration || "";
    if (saved.sortKey) pickerSortKey = saved.sortKey;
    if (saved.sortDir === "asc" || saved.sortDir === "desc") {
      pickerSortDir = saved.sortDir;
    }
  }

  function persistPickerState() {
    const state = {
      searchTerm: searchInput ? searchInput.value : "",
      category: categoryFilter ? categoryFilter.value : "",
      duration: durationFilter ? durationFilter.value : "",
      sortKey: pickerSortKey,
      sortDir: pickerSortDir,
    };
    savePickerState(state);
  }

  // --------------------------- rescan & selection ---------------------------

  async function rescanWorkouts(handle) {
    if (!handle) {
      pickerWorkouts = [];
      renderWorkoutPickerTable();
      return;
    }

    const ok = await ensureDirPermission(handle);
    if (!ok) {
      pickerWorkouts = [];
      handle = null;
      renderWorkoutPickerTable();
      return;
    }

    pickerExpandedKey = null;
    pickerWorkouts = await scanWorkoutsFromDirectory(handle);
    refreshCategoryFilterOptions();

    await restorePickerStateIntoControls();
    renderWorkoutPickerTable();
  }

  function doSelectWorkout(workoutMetaFull) {
    const payload = {
      name: workoutMetaFull.name,
      fileName: workoutMetaFull.fileName,
      totalSec: workoutMetaFull.totalSec,
      segmentsForMetrics: workoutMetaFull.segmentsForMetrics || [],
      ftpFromFile: workoutMetaFull.ftpFromFile,
      tss: workoutMetaFull.tss,
      ifValue: workoutMetaFull.ifValue,
      baseKj: workoutMetaFull.baseKj,
      category: workoutMetaFull.category,
    };

    saveSelectedWorkout(payload);
    onWorkoutSelected(payload);
    close();
  }

  // --------------------------- public API ---------------------------

  async function open() {
    const handle = await loadZwoDirHandle();
    if (!handle) {
      if (summaryEl) {
        summaryEl.textContent = "No ZWO folder selected.";
      }
    } else {
      await rescanWorkouts(handle);
    }

    isPickerOpen = true;
    if (overlay) overlay.style.display = "flex";
    if (searchInput) searchInput.focus();
  }

  function close() {
    isPickerOpen = false;
    if (overlay) overlay.style.display = "none";
  }

  /**
   * Called when FTP changes; re-sorts/re-renders (if open) so adjusted kJ stays accurate.
   */
  function syncFtpChanged() {
    if (isPickerOpen) {
      renderWorkoutPickerTable();
    }
  }

  // --------------------------- initial DOM wiring ---------------------------

  if (closeBtn) {
    closeBtn.addEventListener("click", () => close());
  }
  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
  }
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderWorkoutPickerTable();
      persistPickerState();
    });
  }
  if (categoryFilter) {
    categoryFilter.addEventListener("change", () => {
      renderWorkoutPickerTable();
      persistPickerState();
    });
  }
  if (durationFilter) {
    durationFilter.addEventListener("change", () => {
      renderWorkoutPickerTable();
      persistPickerState();
    });
  }

  setupSorting();
  setupHotkeys();

  return {
    open,
    close,
    syncFtpChanged,
  };
}
