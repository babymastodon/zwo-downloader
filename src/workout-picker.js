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
  inferCategoryFromSegments,
} from "./workout-metrics.js";

import {createWorkoutBuilder} from "./workout-builder.js";

import {renderMiniWorkoutGraph} from "./workout-chart.js";

import {
  ensureDirPermission,
  loadPickerState,
  savePickerState,
  saveSelectedWorkout,
  loadZwoDirHandle,
  loadTrashDirHandle,
} from "./storage.js";

import {
  canonicalWorkoutToZwoXml,
} from "./zwo.js";

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

// Small helper to create inline SVG icons used in picker buttons.
function createIconSvg(kind) {
  const svgNS = "http://www.w3.org/2000/svg";

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.classList.add("wb-code-icon");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  if (kind === "edit") {
    const p1 = document.createElementNS(svgNS, "path");
    p1.setAttribute("d", "M12 20h9");

    const p2 = document.createElementNS(svgNS, "path");
    p2.setAttribute(
      "d",
      "M16.5 3.5l4 4-11 11H5.5v-4.5l11-11z"
    );

    svg.appendChild(p1);
    svg.appendChild(p2);
  } else if (kind === "delete") {
    const p1 = document.createElementNS(svgNS, "path");
    p1.setAttribute("d", "M4 7h16");

    const p2 = document.createElementNS(svgNS, "path");
    p2.setAttribute("d", "M10 11v6");

    const p3 = document.createElementNS(svgNS, "path");
    p3.setAttribute("d", "M14 11v6");

    const p4 = document.createElementNS(svgNS, "path");
    p4.setAttribute("d", "M6 7l1-3h10l1 3");

    const p5 = document.createElementNS(svgNS, "path");
    p5.setAttribute(
      "d",
      "M8 7v11a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V7"
    );

    svg.appendChild(p1);
    svg.appendChild(p2);
    svg.appendChild(p3);
    svg.appendChild(p4);
    svg.appendChild(p5);
  }

  return svg;
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

  const addWorkoutBtn = modal.querySelector("#pickerAddWorkoutBtn");
  const builderBackBtn = modal.querySelector("#workoutBuilderBackBtn");
  const builderClearBtn = modal.querySelector("#workoutBuilderClearBtn");
  const builderSaveBtn = modal.querySelector("#workoutBuilderSaveBtn");
  const builderRoot = modal.querySelector("#workoutBuilderRoot");
  const emptyStateEl = modal.querySelector("#pickerEmptyState");
  const emptyAddBtn = modal.querySelector("#pickerEmptyAddBtn");
  const titleEl = modal.querySelector("#workoutPickerTitle");

  let pickerWorkouts = [];
  let pickerExpandedKey = null;
  let pickerSortKey = "kjAdj";
  let pickerSortDir = "asc";
  let isPickerOpen = false;
  let isBuilderMode = false;

  // IMPORTANT: workoutBuilder.getState() now returns a CanonicalWorkout
  const workoutBuilder =
    builderRoot &&
    createWorkoutBuilder({
      rootEl: builderRoot,
      getCurrentFtp,
    });

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

    if (emptyStateEl) emptyStateEl.style.display = "none";

    const total = pickerWorkouts.length;

    if (total === 0) {
      tbody.innerHTML = "";
      if (summaryEl) {
        summaryEl.textContent = "No .zwo files found in this folder yet.";
      }
      if (!isBuilderMode && emptyStateEl) {
        emptyStateEl.style.display = "flex";
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
        headerRow.style.gap = "6px";
        headerRow.style.marginBottom = "4px";

        // DELETE button
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "wb-code-insert-btn delete-workout-btn";
        deleteBtn.title = "Delete this workout file from your library.";

        const deleteIcon = createIconSvg("delete");
        const deleteText = document.createElement("span");
        deleteText.textContent = "Delete";

        deleteBtn.appendChild(deleteIcon);
        deleteBtn.appendChild(deleteText);

        deleteBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          deleteWorkoutFile(w);
        });

        // EDIT button
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "wb-code-insert-btn edit-workout-btn";
        editBtn.title = "Open this workout in the builder.";

        const editIcon = createIconSvg("edit");
        const editText = document.createElement("span");
        editText.textContent = "Edit";

        editBtn.appendChild(editIcon);
        editBtn.appendChild(editText);

        editBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          openWorkoutInBuilder(w.canonicalWorkout);
        });

        // SELECT button
        const selectBtn = document.createElement("button");
        selectBtn.type = "button";
        selectBtn.className = "select-workout-btn";
        selectBtn.textContent = "Select workout";
        selectBtn.title = "Use this workout on the workout page.";
        selectBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          doSelectWorkout(w.canonicalWorkout);
        });

        headerRow.appendChild(deleteBtn);
        headerRow.appendChild(editBtn);
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

  async function openWorkoutInBuilder(canonicalWorkout) {
    if (!workoutBuilder) {
      console.warn("[WorkoutPicker] Workout builder is not available.");
      return;
    }

    enterBuilderMode();

    try {
      workoutBuilder.loadFromWorkoutMeta(canonicalWorkout);
    } catch (err) {
      console.error("[WorkoutPicker] Failed to load workout into builder:", err);
    }
  }

  function enterBuilderMode() {
    isBuilderMode = true;
    if (builderRoot) builderRoot.style.display = "block";
    if (titleEl) titleEl.textContent = "New Workout";

    if (searchInput) searchInput.style.display = "none";
    if (categoryFilter) categoryFilter.style.display = "none";
    if (durationFilter) durationFilter.style.display = "none";

    if (addWorkoutBtn) addWorkoutBtn.style.display = "none";
    if (builderClearBtn) builderClearBtn.style.display = "inline-flex";
    if (builderSaveBtn) builderSaveBtn.style.display = "inline-flex";
    if (builderBackBtn) builderBackBtn.style.display = "inline-flex";

    modal.classList.add("workout-picker-modal--builder");

    if (emptyStateEl) emptyStateEl.style.display = "none";

    if (workoutBuilder) {
      requestAnimationFrame(() => {
        workoutBuilder.refreshLayout();
      });
    }
  }

  function exitBuilderMode() {
    isBuilderMode = false;
    if (builderRoot) builderRoot.style.display = "none";
    if (titleEl) titleEl.textContent = "Workout library";

    if (searchInput) searchInput.style.display = "";
    if (categoryFilter) categoryFilter.style.display = "";
    if (durationFilter) durationFilter.style.display = "";

    if (addWorkoutBtn) addWorkoutBtn.style.display = "inline-flex";
    if (builderClearBtn) builderClearBtn.style.display = "none";
    if (builderSaveBtn) builderSaveBtn.style.display = "none";
    if (builderBackBtn) builderBackBtn.style.display = "none";

    modal.classList.remove("workout-picker-modal--builder");
  }

  function clearBuilder() {
    if (!workoutBuilder) return;

    /** @type {import('./zwo.js').CanonicalWorkout} */
    const cw = workoutBuilder.getState();

    const hasContent =
      (cw.workoutTitle && cw.workoutTitle.trim()) ||
      (cw.source && cw.source.trim()) ||
      (cw.description && cw.description.trim()) ||
      (Array.isArray(cw.rawSegments) && cw.rawSegments.length > 0);

    if (!hasContent) return;

    const ok = window.confirm(
      "Clear the builder? Unsaved edits will be lost."
    );
    if (!ok) return;

    workoutBuilder.clearState();
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

  function doSelectWorkout(canonicalWorkout) {
    saveSelectedWorkout(canonicalWorkout);
    onWorkoutSelected(canonicalWorkout);
    close();
  }

  // --------------------------- save to library ---------------------------

  function sanitizeZwoFileName(name) {
    const base = (name || "Custom workout").trim() || "Custom workout";
    return base
      .replace(/[\\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  function resetPickerFilters() {
    if (searchInput) searchInput.value = "";
    if (categoryFilter) categoryFilter.value = "";
    if (durationFilter) durationFilter.value = "";

    persistPickerState();
  }

  async function moveWorkoutFileToTrash(fileName) {
    const srcDirHandle = await loadZwoDirHandle();
    const trashDirHandle = await loadTrashDirHandle();

    if (!srcDirHandle) {
      alert(
        "No workout library folder configured.\n\n" +
        "Open Settings and choose a VeloDrive folder first."
      );
      return false;
    }

    if (!trashDirHandle) {
      alert(
        "No trash folder is configured.\n\n" +
        "Open Settings and pick a VeloDrive folder so the trash folder can be created."
      );
      return false;
    }

    const [hasSrcPerm, hasTrashPerm] = await Promise.all([
      ensureDirPermission(srcDirHandle),
      ensureDirPermission(trashDirHandle),
    ]);

    if (!hasSrcPerm) {
      alert(
        "VeloDrive does not have permission to modify your workout library folder.\n\n" +
        "Please re-authorize the folder in Settings."
      );
      return false;
    }

    if (!hasTrashPerm) {
      alert(
        "VeloDrive does not have permission to write to your trash folder.\n\n" +
        "Please re-authorize the VeloDrive folder in Settings."
      );
      return false;
    }

    try {
      const srcFileHandle = await srcDirHandle.getFileHandle(fileName, {create: false});
      const srcFile = await srcFileHandle.getFile();

      const dotIdx = fileName.lastIndexOf(".");
      const base = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
      const ext = dotIdx > 0 ? fileName.slice(dotIdx) : "";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      let destFileName = `${base} (${stamp})${ext}`;

      if (destFileName.length > 120) {
        const shortenedBase = base.slice(0, 80);
        destFileName = `${shortenedBase} (${stamp})${ext}`;
      }

      const destFileHandle = await trashDirHandle.getFileHandle(destFileName, {
        create: true,
      });
      const writable = await destFileHandle.createWritable();
      await writable.write(srcFile);
      await writable.close();

      await srcDirHandle.removeEntry(fileName);

      return true;
    } catch (err) {
      console.error("[WorkoutPicker] Failed to move workout to trash:", err);
      alert(
        "Moving this workout to the trash folder failed. See logs for details."
      );
      return false;
    }
  }

  async function deleteWorkoutFile(workoutMeta) {
    const fileName = workoutMeta.fileName;

    if (!fileName) {
      alert(
        "This workout does not have an associated file name, so it cannot be moved to trash."
      );
      return;
    }

    const dirHandle = await loadZwoDirHandle();
    if (!dirHandle) {
      alert(
        "No workout library folder configured.\n\n" +
        "Open Settings and choose a VeloDrive folder first."
      );
      return;
    }

    const confirmed = window.confirm(
      `Move workout file "${fileName}" to the trash folder?\n\n` +
      "You can restore it later from the trash folder, or delete it permanently from your file system."
    );
    if (!confirmed) return;

    const moved = await moveWorkoutFileToTrash(fileName);
    if (!moved) return;

    await rescanWorkouts(dirHandle);
  }

  async function saveCurrentBuilderWorkoutToZwoDir() {
    if (!workoutBuilder) {
      alert("Workout builder is not available. See logs for details.");
      return;
    }

    try {
      const validation = workoutBuilder.validateForSave();
      if (!validation.ok) {
        return;
      }

      /** @type {import('./zwo.js').CanonicalWorkout} */
      const canonical = workoutBuilder.getState();

      if (!canonical || !Array.isArray(canonical.rawSegments) || !canonical.rawSegments.length) {
        alert("This workout has no intervals to save.");
        return;
      }

      let dirHandle = await loadZwoDirHandle();
      if (!dirHandle) {
        alert(
          "No workout library folder configured.\n\n" +
          "Open Settings and choose a VeloDrive folder first."
        );
        return;
      }

      const hasPerm = await ensureDirPermission(dirHandle);
      if (!hasPerm) {
        alert(
          "VeloDrive does not have permission to write to your workout library folder.\n\n" +
          "Please re-authorize the folder in Settings."
        );
        return;
      }

      const baseName = sanitizeZwoFileName(
        canonical.workoutTitle || "Custom workout"
      );
      const fileName = baseName + ".zwo";

      // Detect overwrite case
      let overwriting = false;
      try {
        await dirHandle.getFileHandle(fileName, {create: false});
        overwriting = true;
      } catch {
        // File does not exist → first save → no overwrite
      }

      if (overwriting) {
        const moved = await moveWorkoutFileToTrash(fileName);
        if (!moved) {
          alert(
            `Failed to move existing workout "${fileName}" to trash.\n\n` +
            "The workout was NOT saved."
          );
          return;
        }
      }

      // Infer category from segments
      const inferredCategory =
        inferCategoryFromSegments(canonical.rawSegments) || "Imported";

      const zwoXml = canonicalWorkoutToZwoXml(canonical, {
        category: inferredCategory,
        sportType: "bike",
      });

      // Write the new file
      try {
        const fileHandle = await dirHandle.getFileHandle(fileName, {create: true});
        const writable = await fileHandle.createWritable();
        await writable.write(zwoXml);
        await writable.close();
      } catch (err) {
        console.error("[WorkoutPicker] Writing new file failed:", err);
        alert(
          `Saving workout "${fileName}" failed while writing the file.\n\n` +
          "See logs for details."
        );
        return;
      }

      // Success → clean up
      workoutBuilder.clearState();
      exitBuilderMode();

      await rescanWorkouts(dirHandle);
      resetPickerFilters();
      pickerExpandedKey = fileName;
      renderWorkoutPickerTable();

    } catch (err) {
      console.error("[WorkoutPicker] Save to ZWO dir failed:", err);
      alert(
        "Unexpected failure while saving workout.\n\n" +
        "See logs for details."
      );
    }
  }

  // --------------------------- public API ---------------------------

  async function open() {
    exitBuilderMode();

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
    if (searchInput && !isBuilderMode) searchInput.focus();
  }

  function close() {
    isPickerOpen = false;
    if (overlay) overlay.style.display = "none";
  }

  function syncFtpChanged() {
    if (isPickerOpen) {
      renderWorkoutPickerTable();
    }
  }

  // --------------------------- initial DOM wiring ---------------------------

  if (closeBtn) {
    closeBtn.addEventListener("click", () => close());
  }
  if (addWorkoutBtn) {
    addWorkoutBtn.addEventListener("click", (e) => {
      e.preventDefault();
      enterBuilderMode();
    });
  }
  if (builderBackBtn) {
    builderBackBtn.addEventListener("click", (e) => {
      e.preventDefault();
      exitBuilderMode();
    });
  }
  if (builderSaveBtn) {
    builderSaveBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      await saveCurrentBuilderWorkoutToZwoDir();
    });
  }
  if (builderClearBtn) {
    builderClearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      clearBuilder();
    });
  }

  if (emptyAddBtn) {
    emptyAddBtn.addEventListener("click", (e) => {
      e.preventDefault();
      enterBuilderMode();
    });
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

