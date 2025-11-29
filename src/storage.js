// storage.js
// Centralized persistence & directory handle helpers for the app.
//
// Handles:
//   - IndexedDB "settings" store for directory handles
//   - chrome.storage.local for extension-local state
//   - chrome.storage.sync for cross-device FTP
//   - File System Access API permissions

// --------------------------- IndexedDB constants ---------------------------

const DB_NAME = "velo-drive";
const DB_VERSION = 1;
const SETTINGS_STORE = "settings";

// Keys for handles in the settings store
export const WORKOUT_DIR_KEY = "workoutDirHandle";
export const ZWO_DIR_KEY = "dirHandle"; // used for ZWO folder (shared with options.js)

// --------------------------- chrome.storage keys ---------------------------

export const STORAGE_SELECTED_WORKOUT = "selectedWorkout";
export const STORAGE_ACTIVE_STATE = "activeWorkoutState";
export const STORAGE_SOUND_ENABLED = "soundEnabled";
export const STORAGE_PICKER_STATE = "pickerState";

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
        db.createObjectStore(SETTINGS_STORE, {keyPath: "key"});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

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
  return saveHandle(WORKOUT_DIR_KEY, handle);
}

export async function loadWorkoutDirHandle() {
  return loadHandle(WORKOUT_DIR_KEY);
}

async function saveZwoDirHandle(handle) {
  return saveHandle(ZWO_DIR_KEY, handle);
}

export async function loadZwoDirHandle() {
  return loadHandle(ZWO_DIR_KEY);
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

// --------------------------- chrome.storage helpers ---------------------------

function hasChromeLocal() {
  try {
    return (
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local
    );
  } catch {
    return false;
  }
}

function hasChromeSync() {
  try {
    return (
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.sync
    );
  } catch {
    return false;
  }
}

// ---- Sound preference ----

export async function loadSoundPreference(defaultValue = true) {
  if (!hasChromeLocal()) return defaultValue;
  return new Promise((resolve) => {
    chrome.storage.local.get(
      {[STORAGE_SOUND_ENABLED]: defaultValue},
      (data) => {
        const raw = data[STORAGE_SOUND_ENABLED];
        if (typeof raw === "boolean") {
          resolve(raw);
        } else {
          resolve(defaultValue);
        }
      }
    );
  });
}

export function saveSoundPreference(enabled) {
  if (!hasChromeLocal()) return;
  chrome.storage.local.set({[STORAGE_SOUND_ENABLED]: !!enabled});
}

// ---- FTP (sync) ----

export function saveFtp(ftpValue) {
  if (!hasChromeSync()) return;
  chrome.storage.sync.set({ftp: ftpValue});
}

// ---- Selected workout ----

export async function loadSelectedWorkout() {
  if (!hasChromeLocal()) return null;
  return new Promise((resolve) => {
    chrome.storage.local.get(
      {[STORAGE_SELECTED_WORKOUT]: null},
      (data) => {
        resolve(data[STORAGE_SELECTED_WORKOUT]);
      }
    );
  });
}

export function saveSelectedWorkout(payload) {
  if (!hasChromeLocal()) return;
  chrome.storage.local.set({[STORAGE_SELECTED_WORKOUT]: payload});
}

// ---- Active workout state ----

export async function loadActiveState() {
  if (!hasChromeLocal()) return null;
  return new Promise((resolve) => {
    chrome.storage.local.get(
      {[STORAGE_ACTIVE_STATE]: null},
      (data) => {
        resolve(data[STORAGE_ACTIVE_STATE]);
      }
    );
  });
}

export function saveActiveState(state) {
  if (!hasChromeLocal()) return;
  chrome.storage.local.set({[STORAGE_ACTIVE_STATE]: state});
}

export function clearActiveState() {
  if (!hasChromeLocal()) return;
  chrome.storage.local.remove(STORAGE_ACTIVE_STATE);
}

// ---- Picker state ----

export async function loadPickerState() {
  if (!hasChromeLocal()) return null;
  return new Promise((resolve) => {
    chrome.storage.local.get(
      {[STORAGE_PICKER_STATE]: null},
      (data) => {
        resolve(data[STORAGE_PICKER_STATE]);
      }
    );
  });
}

export function savePickerState(state) {
  if (!hasChromeLocal()) return;
  chrome.storage.local.set({[STORAGE_PICKER_STATE]: state});
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
