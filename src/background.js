// background.js (Manifest V3 service worker)

const DB_NAME = "zwo-downloader";
const DB_VERSION = 1;

// ---- IndexedDB helpers (same DB/settings store as options.js) ----

function getDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", {keyPath: "key"});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadDirectoryHandle() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("settings", "readonly");
    const store = tx.objectStore("settings");
    const req = store.get("dirHandle");
    req.onsuccess = () => {
      resolve(req.result ? req.result.handle : null);
    };
    req.onerror = () => reject(req.error);
  });
}

async function ensureDirPermission(handle) {
  if (!handle) return false;
  if (!handle.queryPermission || !handle.requestPermission) return true;

  const current = await handle.queryPermission({mode: "readwrite"});
  if (current === "granted") return true;
  if (current === "denied") return false;

  const result = await handle.requestPermission({mode: "readwrite"});
  return result === "granted";
}

// Save the XML into the selected directory as a file
async function saveZwoToDirectory(filename, xmlText) {
  const dirHandle = await loadDirectoryHandle();
  if (!dirHandle) {
    return {ok: false, reason: "noDir"};
  }

  const permitted = await ensureDirPermission(dirHandle);
  if (!permitted) {
    return {ok: false, reason: "noPermission"};
  }

  try {
    // Create or overwrite the file
    const fileHandle = await dirHandle.getFileHandle(filename, {create: true});
    const writable = await fileHandle.createWritable();
    await writable.write(xmlText);
    await writable.close();
    return {ok: true, reason: null};
  } catch (err) {
    console.warn("[ZWO background] Failed to write file:", err);
    return {ok: false, reason: "writeError"};
  }
}

// ---- Handle messages from content scripts ----

chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "TR2ZWO_SAVE_TO_DIR") {
    // Asynchronous response
    (async () => {
      const {filename, xml} = msg;
      if (!filename || !xml) {
        // Include new result fields expected by the content script
        sendResponse({
          ok: false,
          mode: "directory",
          reason: "missingData"
        });
        return;
      }
      const result = await saveZwoToDirectory(filename, xml);

      // Always return the extended shape:
      // { ok: boolean, mode: "directory", reason: string|null }
      sendResponse({
        ok: !!result.ok,
        mode: "directory",
        reason:
          typeof result.reason === "string" && result.reason.length
            ? result.reason
            : null
      });
    })();
    return true; // keep the message channel open for async sendResponse
  }
});

// ---- Open options page after install ----

chrome.runtime.onInstalled.addListener((details) => {
  if (details && details.reason === "install") {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else if (chrome.tabs && chrome.runtime.getURL) {
      chrome.tabs.create({url: chrome.runtime.getURL("workout.html")});
    }
  }
});

// ---- Toolbar icon click → trigger download on active tab ----

chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;

  // Tell the content script in this tab to generate + download the ZWO
  chrome.tabs.sendMessage(
    tab.id,
    {type: "TR2ZWO_DOWNLOAD"},
    () => {
      // Ignore errors when no content script is present
      if (chrome.runtime.lastError) {
        console.warn(
          "[TR2ZWO] Could not send TR2ZWO_DOWNLOAD:",
          chrome.runtime.lastError.message
        );
      }
    }
  );
});

