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
export const WORKOUT_DIR_KEY = "workoutDirHandle";
export const ZWO_DIR_KEY = "dirHandle"; // used for ZWO folder (shared with options.js)

export const STORAGE_SELECTED_WORKOUT = "selectedWorkout";
export const STORAGE_ACTIVE_STATE = "activeWorkoutState";
export const STORAGE_SOUND_ENABLED = "soundEnabled";
export const STORAGE_PICKER_STATE = "pickerState";
export const STORAGE_WORKOUT_BUILDER_STATE = "workoutBuilderState";

const FTP_KEY = "ftp";

// --------------------------- IndexedDB helpers ---------------------------

let dbPromise = null;
let workoutDirHandle = null;
let zwoDirHandle = null;

async function getDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        // Store records as generic { key, value?, handle? }
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

// --- handle-specific helpers (use same store, different field) ---

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
    req.onsuccess = () => {
      resolve(req.result ? req.result.handle : null);
    };
    req.onerror = () => reject(req.error);
  });
}

// Public helpers for specific handles

async function saveWorkoutDirHandle(handle) {
  workoutDirHandle = handle || null;
  return saveHandle(WORKOUT_DIR_KEY, workoutDirHandle);
}

export async function loadWorkoutDirHandle() {
  if (workoutDirHandle) return workoutDirHandle;
  const handle = await loadHandle(WORKOUT_DIR_KEY);
  workoutDirHandle = handle || null;
  return workoutDirHandle;
}

async function saveZwoDirHandle(handle) {
  zwoDirHandle = handle || null;
  return saveHandle(ZWO_DIR_KEY, zwoDirHandle);
}

export async function loadZwoDirHandle() {
  if (zwoDirHandle) return zwoDirHandle;
  const handle = await loadHandle(ZWO_DIR_KEY);
  zwoDirHandle = handle || null;
  return zwoDirHandle;
}

// --------------------------- File system permission helper ---------------------------

export async function ensureDirPermission(handle) {
  if (!handle || !handle.queryPermission || !handle.requestPermission) return false;
  let p = await handle.queryPermission({mode: "readwrite"});
  if (p === "granted") return true;
  if (p === "denied") return false;
  p = await handle.requestPermission({mode: "readwrite"});
  return p === "granted";
}

// --------------------------- Settings using IndexedDB ---------------------------

// ---- Sound preference ----

export async function loadSoundPreference(defaultValue = true) {
  const raw = await getSetting(STORAGE_SOUND_ENABLED, defaultValue);
  return typeof raw === "boolean" ? raw : defaultValue;
}

export function saveSoundPreference(enabled) {
  return setSetting(STORAGE_SOUND_ENABLED, !!enabled);
}

// ---- FTP (sync-ish, but still local IndexedDB here) ----

export function saveFtp(ftpValue) {
  return setSetting(FTP_KEY, ftpValue);
}

// ---- Selected workout ----

export async function loadSelectedWorkout() {
  return getSetting(STORAGE_SELECTED_WORKOUT, null);
}

export function saveSelectedWorkout(payload) {
  return setSetting(STORAGE_SELECTED_WORKOUT, payload);
}

// ---- Active workout state ----

export async function loadActiveState() {
  return getSetting(STORAGE_ACTIVE_STATE, null);
}

export function saveActiveState(state) {
  return setSetting(STORAGE_ACTIVE_STATE, state);
}

export function clearActiveState() {
  return removeSetting(STORAGE_ACTIVE_STATE);
}

// ---- Picker state ----

export async function loadPickerState() {
  return getSetting(STORAGE_PICKER_STATE, null);
}

export function savePickerState(state) {
  return setSetting(STORAGE_PICKER_STATE, state);
}

// -------- Workout builder state persistence (stubs) --------

export async function saveWorkoutBuilderState(state) {
  return setSetting(STORAGE_WORKOUT_BUILDER_STATE, state);
}

export async function loadWorkoutBuilderState() {
  return getSetting(STORAGE_WORKOUT_BUILDER_STATE, null);
}

// --------------------------- directory helpers ---------------------------

export async function pickZwoDirectory() {
  if (!("showDirectoryPicker" in window)) {
    alert("Selecting ZWO workouts requires a recent Chromium-based browser.");
    return null;
  }

  try {
    // Always force the user to pick a directory
    const handle = await window.showDirectoryPicker();

    const ok = await ensureDirPermission(handle);
    if (!ok) {
      alert("Permission was not granted to the selected ZWO folder.");
      return null;
    }

    // Save the newly chosen folder
    zwoDirHandle = handle;
    await saveZwoDirHandle(handle);

    return zwoDirHandle;
  } catch (err) {
    if (err && err.name === "AbortError") {
      // user canceled
      return null;
    }
    console.error("Error choosing ZWO folder: " + err);
    alert("Failed to choose ZWO folder.");
    return null;
  }
}

export async function pickWorkoutDir() {
  if (!("showDirectoryPicker" in window)) {
    alert("Saving workouts requires a recent Chromium-based browser.");
    return null;
  }

  try {
    // Always prompt the user
    const handle = await window.showDirectoryPicker();

    const ok = await ensureDirPermission(handle);
    if (!ok) {
      alert("Permission was not granted to the selected folder.");
      return null;
    }

    workoutDirHandle = handle;
    await saveWorkoutDirHandle(handle);

    return workoutDirHandle;
  } catch (err) {
    if (err && err.name === "AbortError") {
      // user canceled
      return null;
    }
    console.error("Error choosing workout folder: " + err);
    alert("Failed to choose workout folder.");
    return null;
  }
}

