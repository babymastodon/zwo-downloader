// storage.js
// Centralized persistence & directory handle helpers for the app.
//
// Handles:
//   - IndexedDB "settings" store for directory handles & extension-local state
//   - File System Access API permissions

// --------------------------- IndexedDB constants ---------------------------

const DB_NAME = "velo-drive";
const DB_VERSION = 1;
const SETTINGS_STORE = "settings";

// Keys in the settings store
export const WORKOUT_DIR_KEY = "workoutDirHandle";       // history dir (per-workout data)
export const ZWO_DIR_KEY = "dirHandle";                  // workouts (.zwo) dir (shared with options.js)

export const ROOT_DIR_KEY = "rootDirHandle";
export const TRASH_DIR_KEY = "trashDirHandle";

export const STORAGE_SELECTED_WORKOUT = "selectedWorkout";
export const STORAGE_ACTIVE_STATE = "activeWorkoutState";
export const STORAGE_SOUND_ENABLED = "soundEnabled";
export const STORAGE_PICKER_STATE = "pickerState";
export const STORAGE_WORKOUT_BUILDER_STATE = "workoutBuilderState";
export const STORAGE_LAST_SCRAPED_WORKOUT = "lastScrapedWorkout";
export const STORAGE_LAST_SCRAPED_FLAG = "lastScrapedWorkoutJustScraped";

const FTP_KEY = "ftp";

// --------------------------- IndexedDB helpers ---------------------------

let dbPromise = null;
let workoutDirHandle = null;
let zwoDirHandle = null;
let rootDirHandle = null;
let trashDirHandle = null;

async function getDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, {keyPath: "key"});
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

// --- generic key/value helpers (for non-handle data) ---

async function setSetting(key, value) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, "readwrite");
    const store = tx.objectStore(SETTINGS_STORE);
    store.put({key, value});
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getSetting(key, defaultValue = null) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, "readonly");
    const store = tx.objectStore(SETTINGS_STORE);
    const req = store.get(key);
    req.onsuccess = () => {
      const record = req.result;
      if (!record || !("value" in record)) {
        resolve(defaultValue);
      } else {
        resolve(record.value);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

async function removeSetting(key) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, "readwrite");
    const store = tx.objectStore(SETTINGS_STORE);
    store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- handle-specific helpers ---

async function saveHandle(key, handle) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, "readwrite");
    const store = tx.objectStore(SETTINGS_STORE);
    store.put({key, handle});
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadHandle(key) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, "readonly");
    const store = tx.objectStore(SETTINGS_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ? req.result.handle : null);
    req.onerror = () => reject(req.error);
  });
}

// --------------------------- Persisted handles ---------------------------

// History directory
async function saveWorkoutDirHandle(handle) {
  workoutDirHandle = handle || null;
  return saveHandle(WORKOUT_DIR_KEY, workoutDirHandle);
}

export async function loadWorkoutDirHandle() {
  if (workoutDirHandle) return workoutDirHandle;

  let handle = await loadHandle(WORKOUT_DIR_KEY);

  // derive from root
  if (!handle) {
    const root = await loadRootDirHandle();
    if (root) {
      handle = await root.getDirectoryHandle("history", {create: true});
      await saveWorkoutDirHandle(handle);
    }
  }

  workoutDirHandle = handle || null;
  return workoutDirHandle;
}

// Workouts (.zwo) directory
async function saveZwoDirHandle(handle) {
  zwoDirHandle = handle || null;
  return saveHandle(ZWO_DIR_KEY, zwoDirHandle);
}

export async function loadZwoDirHandle() {
  if (zwoDirHandle) return zwoDirHandle;

  let handle = await loadHandle(ZWO_DIR_KEY);

  // derive from root
  if (!handle) {
    const root = await loadRootDirHandle();
    if (root) {
      handle = await root.getDirectoryHandle("workouts", {create: true});
      await saveZwoDirHandle(handle);
    }
  }

  zwoDirHandle = handle || null;
  return zwoDirHandle;
}

// Root
async function saveRootDirHandle(handle) {
  rootDirHandle = handle || null;
  return saveHandle(ROOT_DIR_KEY, rootDirHandle);
}

export async function loadRootDirHandle() {
  if (rootDirHandle) return rootDirHandle;
  const handle = await loadHandle(ROOT_DIR_KEY);
  rootDirHandle = handle || null;
  return rootDirHandle;
}

// Trash
async function saveTrashDirHandle(handle) {
  trashDirHandle = handle || null;
  return saveHandle(TRASH_DIR_KEY, trashDirHandle);
}

export async function loadTrashDirHandle() {
  if (trashDirHandle) return trashDirHandle;

  let handle = await loadHandle(TRASH_DIR_KEY);

  // derive from root
  if (!handle) {
    const root = await loadRootDirHandle();
    if (root) {
      handle = await root.getDirectoryHandle("trash", {create: true});
      await saveTrashDirHandle(handle);
    }
  }

  trashDirHandle = handle || null;
  return trashDirHandle;
}

// --------------------------- Scrape result helpers ---------------------------

export async function loadLastScrapedWorkout() {
  // Shape (as saved by background.js):
  // {
  //   success: boolean,
  //   source: string,
  //   sourceURL: string,
  //   workoutTitle: string,
  //   rawSegments: any,
  //   description: string,
  //   scrapedAt: string (ISO timestamp),
  //   error?: string
  // }
  return getSetting(STORAGE_LAST_SCRAPED_WORKOUT, null);
}

export function saveLastScrapedWorkout(payload) {
  return setSetting(STORAGE_LAST_SCRAPED_WORKOUT, payload);
}

export function markLastScrapeJustScraped(value) {
  return setSetting(STORAGE_LAST_SCRAPED_FLAG, !!value);
}

export async function wasWorkoutJustScraped() {
  return getSetting(STORAGE_LAST_SCRAPED_FLAG, false);
}

export function clearJustScrapedFlag() {
  // Call this from workout.html once you've consumed the latest scrape.
  return setSetting(STORAGE_LAST_SCRAPED_FLAG, false);
}


// --------------------------- Permission helper ---------------------------

export async function ensureDirPermission(handle) {
  if (!handle || !handle.queryPermission || !handle.requestPermission) return false;
  let p = await handle.queryPermission({mode: "readwrite"});
  if (p === "granted") return true;
  if (p === "denied") return false;
  p = await handle.requestPermission({mode: "readwrite"});
  return p === "granted";
}

// --------------------------- Settings (IndexedDB) ---------------------------

export async function loadSoundPreference(defaultValue = true) {
  const raw = await getSetting(STORAGE_SOUND_ENABLED, defaultValue);
  return typeof raw === "boolean" ? raw : defaultValue;
}

export function saveSoundPreference(enabled) {
  return setSetting(STORAGE_SOUND_ENABLED, !!enabled);
}

export function saveFtp(ftpValue) {
  return setSetting(FTP_KEY, ftpValue);
}

export async function loadSelectedWorkout() {
  return getSetting(STORAGE_SELECTED_WORKOUT, null);
}

export function saveSelectedWorkout(payload) {
  return setSetting(STORAGE_SELECTED_WORKOUT, payload);
}

export async function loadActiveState() {
  return getSetting(STORAGE_ACTIVE_STATE, null);
}

export function saveActiveState(state) {
  return setSetting(STORAGE_ACTIVE_STATE, state);
}

export function clearActiveState() {
  return removeSetting(STORAGE_ACTIVE_STATE);
}

export async function loadPickerState() {
  return getSetting(STORAGE_PICKER_STATE, null);
}

export function savePickerState(state) {
  return setSetting(STORAGE_PICKER_STATE, state);
}

export async function saveWorkoutBuilderState(state) {
  return setSetting(STORAGE_WORKOUT_BUILDER_STATE, state);
}

export async function loadWorkoutBuilderState() {
  return getSetting(STORAGE_WORKOUT_BUILDER_STATE, null);
}

// --------------------------- Root Directory Picker ---------------------------

/**
 * Prompts user once for a root directory, then ensures:
 *   - root/workouts/
 *   - root/history/
 *   - root/trash/
 *
 * Saves all dir handles.
 */
export async function pickRootDir() {
  if (!("showDirectoryPicker" in window)) {
    alert("Selecting a data folder requires a recent Chromium-based browser.");
    return null;
  }

  try {
    const root = await window.showDirectoryPicker();

    const ok = await ensureDirPermission(root);
    if (!ok) {
      alert("Permission was not granted to the selected folder.");
      return null;
    }

    await saveRootDirHandle(root);

    // ensure subdirs exist
    const workouts = await root.getDirectoryHandle("workouts", {create: true});
    const history = await root.getDirectoryHandle("history", {create: true});
    const trash = await root.getDirectoryHandle("trash", {create: true});

    await saveZwoDirHandle(workouts);
    await saveWorkoutDirHandle(history);
    await saveTrashDirHandle(trash);

    return root;

  } catch (err) {
    if (err?.name === "AbortError") return null;
    console.error("Error choosing root folder:", err);
    alert("Failed to choose folder.");
    return null;
  }
}

