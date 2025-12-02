// workout-picker.js
// Singleton for the ZWO workout picker modal.
//
// Encapsulates:
//   - ZWO directory selection & permission
//   - scanning/parsing .zwo files
//   - metrics-based sorting/filtering
//   - rendering mini workout graphs
//   - keyboard navigation & state persistence
//
// NOTE: CanonicalWorkout is the primary data structure.
// ZWO files are parsed via parseZwoXmlToCanonicalWorkout, and ALL metrics
// are derived from CanonicalWorkout.rawSegments + current FTP.

import {
  computeMetricsFromSegments,
  getDurationBucket,
  inferZoneFromSegments,
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
  parseZwoXmlToCanonicalWorkout,
  canonicalWorkoutToZwoXml,
} from "./zwo.js";

let instance = null;

/**
 * CanonicalWorkout shape (for reference):
 *
 * @typedef CanonicalWorkout
 * @property {string} source
 * @property {string} sourceURL
 * @property {string} workoutTitle
 * @property {Array<[number, number, number]>} rawSegments
 * @property {string} description
 */

/**
 * @typedef PickerConfig
 * @property {HTMLElement} overlay
 * @property {HTMLElement} modal
 * @property {HTMLButtonElement} closeBtn
 * @property {HTMLInputElement} searchInput
 * @property {HTMLSelectElement} zoneFilter
 * @property {HTMLSelectElement} durationFilter
 * @property {HTMLElement} summaryEl
 * @property {HTMLElement} tbody
 * @property {() => number} getCurrentFtp
 * @property {(payload: any) => void} onWorkoutSelected
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

// --------------------------- ZWO scanning & metrics ---------------------------

/**
 * Scan a directory and return an array of CanonicalWorkout.
 *
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<CanonicalWorkout[]>}
 */
async function scanWorkoutsFromDirectory(handle) {
  /** @type {CanonicalWorkout[]} */
  const workouts = [];
  try {
    for await (const entry of handle.values()) {
      if (entry.kind !== "file") continue;
      if (!entry.name.toLowerCase().endsWith(".zwo")) continue;

      const file = await entry.getFile();
      const text = await file.text();

      const canonicalWorkout = parseZwoXmlToCanonicalWorkout(text);
      if (!canonicalWorkout) continue;

      workouts.push(canonicalWorkout);
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
    // Classic, normal trash can icon (Feather-style)
    const p1 = document.createElementNS(svgNS, "path");
    p1.setAttribute("d", "M3 6h18"); // top bar

    const p2 = document.createElementNS(svgNS, "path");
    p2.setAttribute("d", "M8 6V4h8v2"); // handle

    const p3 = document.createElementNS(svgNS, "path");
    p3.setAttribute("d", "M6 6l1 14h10l1-14"); // can outline

    const p4 = document.createElementNS(svgNS, "path");
    p4.setAttribute("d", "M10 11v6"); // inner line L

    const p5 = document.createElementNS(svgNS, "path");
    p5.setAttribute("d", "M14 11v6"); // inner line R

    svg.appendChild(p1);
    svg.appendChild(p2);
    svg.appendChild(p3);
    svg.appendChild(p4);
    svg.appendChild(p5);

  } else if (kind === "link") {
    // External-link style icon
    const p1 = document.createElementNS(svgNS, "path");
    p1.setAttribute("d", "M18 3h3v3");
    const p2 = document.createElementNS(svgNS, "path");
    p2.setAttribute("d", "M21 3l-9 9");
    const p3 = document.createElementNS(svgNS, "path");
    p3.setAttribute(
      "d",
      "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"
    );
    svg.appendChild(p1);
    svg.appendChild(p2);
    svg.appendChild(p3);
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
    zoneFilter,
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

  /** @type {CanonicalWorkout[]} */
  let pickerWorkouts = [];
  let pickerExpandedTitle = null;  // track by workoutTitle
  let pickerSortKey = "kjAdj";     // header label preserved, but this is kJ @ current FTP
  let pickerSortDir = "asc";
  let isPickerOpen = false;
  let isBuilderMode = false;

  // workoutBuilder.getState() returns a CanonicalWorkout
  const workoutBuilder =
    builderRoot &&
    createWorkoutBuilder({
      rootEl: builderRoot,
      getCurrentFtp,
    });

  // --------------------------- helpers for derived info ---------------------------

  function getCanonicalZone(cw) {
    return inferZoneFromSegments(cw.rawSegments) || "Uncategorized";
  }

  /**
   * Structure returned from computeVisiblePickerWorkouts:
   *   { canonical, zone, metrics }
   *
   * All display fields (title, description, source, etc.) are taken
   * directly from `canonical` elsewhere. Only `zone` + `metrics`
   * are derived here.
   */
  function computeVisiblePickerWorkouts() {
    const searchTerm = (searchInput?.value || "").toLowerCase();
    const zoneValue = zoneFilter?.value || "";
    const durValue = durationFilter?.value || "";
    const currentFtp = getCurrentFtp();

    /** @type {{ canonical: CanonicalWorkout, zone: string, metrics: any }[]} */
    let items = pickerWorkouts.map((canonical) => {
      const metrics = computeMetricsFromSegments(
        canonical.rawSegments,
        currentFtp
      );
      const zone = getCanonicalZone(canonical);
      return {canonical, zone, metrics};
    });

    if (zoneValue) {
      items = items.filter((item) => item.zone === zoneValue);
    }

    if (durValue) {
      items = items.filter((item) =>
        getDurationBucket(item.metrics.durationMin) === durValue
      );
    }

    if (searchTerm) {
      items = items.filter((item) => {
        const {canonical} = item;
        const title = canonical.workoutTitle;
        const source = canonical.source || "";
        const description = canonical.description || "";
        const haystack = [
          title,
          item.zone,
          source,
          description.slice(0, 300),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(searchTerm);
      });
    }

    const sortKey = pickerSortKey;
    const dir = pickerSortDir === "asc" ? 1 : -1;
    const num = (val) => (Number.isFinite(val) ? val : -Infinity);

    items = items.slice().sort((a, b) => {
      if (sortKey === "kjAdj") {
        return (num(a.metrics.kj) - num(b.metrics.kj)) * dir;
      }
      if (sortKey === "if") {
        return (num(a.metrics.ifValue) - num(b.metrics.ifValue)) * dir;
      }
      if (sortKey === "tss") {
        return (num(a.metrics.tss) - num(b.metrics.tss)) * dir;
      }
      if (sortKey === "duration") {
        return (
          num(a.metrics.durationMin) - num(b.metrics.durationMin)
        ) * dir;
      }
      if (sortKey === "name") {
        return a.canonical.workoutTitle.localeCompare(
          b.canonical.workoutTitle
        ) * dir;
      }
      return 0;
    });

    return items;
  }

  function updateSortHeaderIndicator() {
    if (!modal) return;
    const headers = modal.querySelectorAll("th[data-sort-key]");
    headers.forEach((th) => {
      const key = th.getAttribute("data-sort-key");
      th.classList.remove("sorted-asc", "sorted-desc");
      if (key === pickerSortKey) {
        th.classList.add(
          pickerSortDir === "asc" ? "sorted-asc" : "sorted-desc"
        );
      }
    });
  }

  // --------------------------- rendering ---------------------------
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

    const shownItems = computeVisiblePickerWorkouts();
    const shownCount = shownItems.length;

    tbody.innerHTML = "";

    if (summaryEl) {
      summaryEl.textContent = `${shownCount} of ${total} workouts shown`;
    }

    const colCount = 7;
    const currentFtp = getCurrentFtp();

    for (const item of shownItems) {
      const {canonical, zone, metrics} = item;
      const title = canonical.workoutTitle;
      const source = canonical.source || "";
      const description = canonical.description || "";

      const isExpanded = pickerExpandedTitle === title;

      if (!isExpanded) {
        // --------- Normal (collapsed) row ----------
        const tr = document.createElement("tr");
        tr.className = "picker-row";
        tr.dataset.title = title;

        const tdName = document.createElement("td");
        tdName.textContent = title;
        tdName.title = title;
        tr.appendChild(tdName);

        const tdCat = document.createElement("td");
        tdCat.textContent = zone || "Uncategorized";
        tr.appendChild(tdCat);

        const tdSource = document.createElement("td");
        tdSource.textContent = source;
        tr.appendChild(tdSource);

        const tdIf = document.createElement("td");
        tdIf.textContent =
          metrics.ifValue != null ? metrics.ifValue.toFixed(2) : "";
        tr.appendChild(tdIf);

        const tdTss = document.createElement("td");
        tdTss.textContent =
          metrics.tss != null ? String(Math.round(metrics.tss)) : "";
        tr.appendChild(tdTss);

        const tdDur = document.createElement("td");
        tdDur.textContent =
          metrics.durationMin != null
            ? `${Math.round(metrics.durationMin)} min`
            : "";
        tr.appendChild(tdDur);

        const tdKj = document.createElement("td");
        tdKj.textContent =
          metrics.kj != null ? `${Math.round(metrics.kj)} kJ` : "";
        tr.appendChild(tdKj);

        tbody.appendChild(tr);

        tr.addEventListener("click", () => {
          pickerExpandedTitle =
            pickerExpandedTitle === title ? null : title;
          renderWorkoutPickerTable();
        });
      } else {
        // --------- Expanded row ONLY (header + tags/description + full-width chart) ----------
        const expTr = document.createElement("tr");
        expTr.className = "picker-expanded-row";
        expTr.dataset.title = title;

        const expTd = document.createElement("td");
        expTd.colSpan = colCount;

        // Use both the original layout class + our column override
        const container = document.createElement("div");
        container.className = "picker-expanded picker-expanded-layout";

        /* =========================
           HEADER: title left, buttons right (2-row layout)
           ========================= */
        const headerBar = document.createElement("div");
        headerBar.className = "picker-expanded-header";

        // Title (grid column 1)
        const titleElDiv = document.createElement("div");
        titleElDiv.className = "picker-expanded-title";
        titleElDiv.textContent = title;

        // Button group (grid column 2)
        const actionsRow = document.createElement("div");
        actionsRow.className = "picker-expanded-actions";

        // VISIT WEBSITE button (if URL exists)
        if (canonical.sourceURL) {
          const visitBtn = document.createElement("button");
          visitBtn.type = "button";
          visitBtn.className = "wb-code-insert-btn visit-website-btn";
          visitBtn.title = "Open the workout's website in a new tab.";

          const linkIcon = createIconSvg("link");  // uses your existing icon function
          const linkText = document.createElement("span");
          linkText.textContent = "Visit website";

          visitBtn.appendChild(linkIcon);
          visitBtn.appendChild(linkText);

          visitBtn.addEventListener("click", (evt) => {
            evt.stopPropagation();
            window.open(canonical.sourceURL, "_blank");
          });

          // Insert BEFORE delete
          actionsRow.appendChild(visitBtn);
        }

        // DELETE button
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className =
          "wb-code-insert-btn delete-workout-btn";
        deleteBtn.title =
          "Delete this workout file from your library.";

        const deleteIcon = createIconSvg("delete");
        const deleteText = document.createElement("span");
        deleteText.textContent = "Delete";
        deleteBtn.appendChild(deleteIcon);
        deleteBtn.appendChild(deleteText);

        deleteBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          deleteWorkoutFile(canonical);
        });

        // EDIT button
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className =
          "wb-code-insert-btn edit-workout-btn";
        editBtn.title = "Open this workout in the builder.";

        const editIcon = createIconSvg("edit");
        const editText = document.createElement("span");
        editText.textContent = "Edit";
        editBtn.appendChild(editIcon);
        editBtn.appendChild(editText);

        editBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          openWorkoutInBuilder(canonical);
        });

        // SELECT button
        const selectBtn = document.createElement("button");
        selectBtn.type = "button";
        selectBtn.className = "select-workout-btn";
        selectBtn.textContent = "Select workout";
        selectBtn.title =
          "Use this workout on the workout page.";
        selectBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          doSelectWorkout(canonical);
        });

        actionsRow.appendChild(deleteBtn);
        actionsRow.appendChild(editBtn);
        actionsRow.appendChild(selectBtn);

        // Put into header (grid auto-places them into the two columns)
        headerBar.appendChild(titleElDiv);
        headerBar.appendChild(actionsRow);
        container.appendChild(headerBar);

        /* =========================
           CONTENT 1: tags (left) + description (right)
           ========================= */
        const contentRow1 = document.createElement("div");
        contentRow1.className = "picker-expanded-main";

        // Left: tags / stats
        const tagsCol = document.createElement("div");
        tagsCol.className = "picker-expanded-main-left";

        const tagsRow = document.createElement("div");
        tagsRow.className = "wb-stats-row";

        // Chips (using original helper signature)
        const zoneChip = createStatChip("Zone");
        zoneChip.value.textContent = zone || "Uncategorized";
        tagsRow.appendChild(zoneChip.el);

        if (source) {
          const sourceChip = createStatChip("Source");
          sourceChip.value.textContent = source;
          tagsRow.appendChild(sourceChip.el);
        }

        if (metrics.ifValue != null) {
          const ifChip = createStatChip("IF");
          ifChip.value.textContent = metrics.ifValue.toFixed(2);
          tagsRow.appendChild(ifChip.el);
        }

        if (metrics.tss != null) {
          const tssChip = createStatChip("TSS");
          tssChip.value.textContent = String(Math.round(metrics.tss));
          tagsRow.appendChild(tssChip.el);
        }

        if (metrics.durationMin != null) {
          const durChip = createStatChip("Duration");
          durChip.value.textContent = `${Math.round(
            metrics.durationMin
          )} min`;
          tagsRow.appendChild(durChip.el);
        }

        if (metrics.kj != null) {
          const kjChip = createStatChip("kJ");
          kjChip.value.textContent = `${Math.round(metrics.kj)}`;
          tagsRow.appendChild(kjChip.el);
        }

        tagsCol.appendChild(tagsRow);

        // Right: description
        const descCol = document.createElement("div");
        descCol.className = "picker-expanded-main-right";
        descCol.style.fontSize = "var(--font-size-base)";
        descCol.style.lineHeight = "1.6";

        if (description && description.trim()) {
          descCol.innerHTML = description.replace(/\n/g, "<br>");
        } else {
          descCol.textContent = "(No description)";
          descCol.className = "picker-detail-empty";
        }

        contentRow1.appendChild(tagsCol);
        contentRow1.appendChild(descCol);
        container.appendChild(contentRow1);

        /* =========================
           CONTENT 2: full-width chart (same height)
           ========================= */
        const contentRow2 = document.createElement("div");
        contentRow2.className = "picker-expanded-chart";

        const graphDiv = document.createElement("div");
        graphDiv.className = "picker-graph";

        contentRow2.appendChild(graphDiv);
        container.appendChild(contentRow2);

        expTd.appendChild(container);
        expTr.appendChild(expTd);
        tbody.appendChild(expTr);

        renderMiniWorkoutGraph(graphDiv, canonical, currentFtp);

        // NOTE: no click handler on expTr — clicking does NOT collapse the row
      }
    }

    updateSortHeaderIndicator();

    // After rendering, scroll the expanded row into view (if any).
    requestAnimationFrame(() => {
      if (!pickerExpandedTitle || !tbody) return;
      const expandedRow = tbody.querySelector(".picker-expanded-row");
      if (!expandedRow) return;

      expandedRow.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    });
  }

  async function openWorkoutInBuilder(canonicalWorkout) {
    if (!workoutBuilder) {
      console.warn("[WorkoutPicker] Workout builder is not available.");
      return;
    }

    enterBuilderMode();

    try {
      workoutBuilder.loadCanonicalWorkout(canonicalWorkout);
    } catch (err) {
      console.error(
        "[WorkoutPicker] Failed to load workout into builder:",
        err
      );
    }
  }

  function enterBuilderMode() {
    isBuilderMode = true;
    if (builderRoot) builderRoot.style.display = "block";
    if (titleEl) titleEl.textContent = "New Workout";

    if (searchInput) searchInput.style.display = "none";
    if (zoneFilter) zoneFilter.style.display = "none";
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
    if (zoneFilter) zoneFilter.style.display = "";
    if (durationFilter) durationFilter.style.display = "";

    if (addWorkoutBtn) addWorkoutBtn.style.display = "inline-flex";
    if (builderClearBtn) builderClearBtn.style.display = "none";
    if (builderSaveBtn) builderSaveBtn.style.display = "none";
    if (builderBackBtn) builderBackBtn.style.display = "none";

    modal.classList.remove("workout-picker-modal--builder");
  }

  function clearBuilder() {
    if (!workoutBuilder) return;

    /** @type {CanonicalWorkout} */
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
    const shownItems = computeVisiblePickerWorkouts();
    if (!shownItems.length) return;

    let idx = shownItems.findIndex(
      (item) => item.canonical.workoutTitle === pickerExpandedTitle
    );

    if (idx === -1) {
      idx = delta > 0 ? 0 : shownItems.length - 1;
    } else {
      idx = (idx + delta + shownItems.length) % shownItems.length;
    }

    pickerExpandedTitle = shownItems[idx].canonical.workoutTitle;
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
    if (zoneFilter) zoneFilter.value = saved.zone || "";
    if (durationFilter) durationFilter.value = saved.duration || "";
    if (saved.sortKey) pickerSortKey = saved.sortKey;
    if (saved.sortDir === "asc" || saved.sortDir === "desc") {
      pickerSortDir = saved.sortDir;
    }
  }

  function persistPickerState() {
    const state = {
      searchTerm: searchInput ? searchInput.value : "",
      zone: zoneFilter ? zoneFilter.value : "",
      duration: durationFilter ? durationFilter.value : "",
      sortKey: pickerSortKey,
      sortDir: pickerSortDir,
    };
    savePickerState(state);
  }

  // --------------------------- rescan & selection ---------------------------

  async function rescanWorkouts(handle, options = {}) {
    const {skipRestoreState = false} = options;

    if (!handle) {
      pickerWorkouts = [];
      renderWorkoutPickerTable();
      return;
    }

    const ok = await ensureDirPermission(handle);
    if (!ok) {
      pickerWorkouts = [];
      renderWorkoutPickerTable();
      return;
    }

    pickerExpandedTitle = null;
    pickerWorkouts = await scanWorkoutsFromDirectory(handle);

    if (!skipRestoreState) {
      await restorePickerStateIntoControls();
    }

    renderWorkoutPickerTable();
  }

  function doSelectWorkout(canonicalWorkout) {
    saveSelectedWorkout(canonicalWorkout);
    onWorkoutSelected(canonicalWorkout);
    close();
  }

  // --------------------------- save to library ---------------------------

  function resetPickerFilters() {
    if (searchInput) searchInput.value = "";
    if (zoneFilter) zoneFilter.value = "";
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
      const srcFileHandle =
        await srcDirHandle.getFileHandle(fileName, {
          create: false,
        });
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

      const destFileHandle =
        await trashDirHandle.getFileHandle(destFileName, {
          create: true,
        });
      const writable = await destFileHandle.createWritable();
      await writable.write(srcFile);
      await writable.close();

      await srcDirHandle.removeEntry(fileName);

      return true;
    } catch (err) {
      console.error(
        "[WorkoutPicker] Failed to move workout to trash:",
        err
      );
      alert(
        "Moving this workout to the trash folder failed. See logs for details."
      );
      return false;
    }
  }

  async function deleteWorkoutFile(canonicalWorkout) {
    const title = canonicalWorkout.workoutTitle;
    const fileName = sanitizeZwoFileName(title) + ".zwo";

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
      alert(
        "Workout builder is not available. See logs for details."
      );
      return;
    }

    try {
      const validation = workoutBuilder.validateForSave();
      if (!validation.ok) {
        // validateForSave is assumed to show its own messages
        return;
      }

      /** @type {CanonicalWorkout} */
      const canonical = workoutBuilder.getState();

      if (
        !canonical ||
        !Array.isArray(canonical.rawSegments) ||
        !canonical.rawSegments.length
      ) {
        alert("This workout has no intervals to save.");
        return;
      }

      const result = await saveCanonicalWorkoutToZwoDir(canonical);
      if (!result.ok) {
        // Helper already alerted the user.
        return;
      }

      // Success → clean up + refresh UI
      workoutBuilder.clearState();
      open(canonical.workoutTitle);
    } catch (err) {
      console.error(
        "[WorkoutPicker] Save to ZWO dir failed:",
        err
      );
      alert(
        "Unexpected failure while saving workout.\n\n" +
        "See logs for details."
      );
    }
  }

  /**
   * Injective mapping from title → file-safe base name.
   * encodeURIComponent is injective on strings and yields only
   * filesystem-safe characters.
   */
  function sanitizeZwoFileName(title) {
    return encodeURIComponent(title);
  }

  /**
   * Save a CanonicalWorkout as a .zwo file in the configured ZWO directory.
   * Handles:
   *   - no ZWO folder selected
   *   - permission issues
   *   - overwriting by moving old file to trash first
   *   - actual write failures
   *
   * This function is responsible for user-facing alerts.
   *
   * @param {CanonicalWorkout} canonical
   * @returns {Promise<{ ok: boolean, fileName?: string, dirHandle?: FileSystemDirectoryHandle }>}
   */
  async function saveCanonicalWorkoutToZwoDir(canonical) {
    let dirHandle = await loadZwoDirHandle();
    if (!dirHandle) {
      alert(
        "No workout library folder configured.\n\n" +
        "Open Settings and choose a VeloDrive folder first."
      );
      return {ok: false};
    }

    const hasPerm = await ensureDirPermission(dirHandle);
    if (!hasPerm) {
      alert(
        "VeloDrive does not have permission to write to your workout library folder.\n\n" +
        "Please re-authorize the folder in Settings."
      );
      return {ok: false};
    }

    const baseName = sanitizeZwoFileName(canonical.workoutTitle);
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
        return {ok: false};
      }
    }

    const zwoXml = canonicalWorkoutToZwoXml(canonical);

    // Write the new file
    try {
      const fileHandle = await dirHandle.getFileHandle(fileName, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(zwoXml);
      await writable.close();
    } catch (err) {
      console.error("[WorkoutPicker] Writing new file failed:", err);
      alert(
        `Saving workout "${fileName}" failed while writing the file.\n\n` +
        "See logs for details."
      );
      return {ok: false};
    }

    return {ok: true, fileName, dirHandle};
  }

  // --------------------------- public API ---------------------------

  /**
   * Open the workout picker.
   *
   * @param {string} [workoutTitle]  Optional workout title to focus/expand.
   *                                 When provided, picker filters are only
   *                                 cleared if the workout would not be visible
   *                                 with the current picker controls.
   */
  async function open(workoutTitle) {
    exitBuilderMode();

    const handle = await loadZwoDirHandle();
    const hasTargetTitle =
      typeof workoutTitle === "string" && workoutTitle.trim().length > 0;

    if (!handle) {
      if (summaryEl) {
        summaryEl.textContent = "No ZWO folder selected.";
      }
    } else {
      // Always rescan and restore previous picker state first
      await rescanWorkouts(handle);

      if (hasTargetTitle) {
        // Check if the requested workout is visible with current filters.
        const isTargetVisible = computeVisiblePickerWorkouts().some(
          (item) => item.canonical.workoutTitle === workoutTitle
        );

        // Only clear filters if the workout is hidden by them.
        if (!isTargetVisible) {
          resetPickerFilters();
        }

        pickerExpandedTitle = workoutTitle;
        renderWorkoutPickerTable();
      }
    }

    isPickerOpen = true;
    if (overlay) overlay.style.display = "flex";

    // Only auto-focus search when not targeting a specific workout.
    if (searchInput && !isBuilderMode && !hasTargetTitle) {
      searchInput.focus();
    }
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

  if (zoneFilter) {
    zoneFilter.addEventListener("change", () => {
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
    saveCanonicalWorkoutToZwoDir,
  };
}
