// background.js (Manifest V3 service worker for VeloDrive - ES module)

import {
  saveLastScrapedWorkout,
  markLastScrapeJustScraped,
} from "./storage.js";

// ---------------- Helpers ----------------

async function saveScrapeResult(scrape) {
  const payload = {
    ...scrape,
    scrapedAt: new Date().toISOString(),
  };

  // Save full payload including `success` flag
  await saveLastScrapedWorkout(payload);
  await markLastScrapeJustScraped(true);
}

function openOptionsPage() {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else if (chrome.tabs && chrome.runtime.getURL) {
    chrome.tabs.create({url: chrome.runtime.getURL("workout.html")});
  }
}

// ---------------- Lifecycle events ----------------

// On install: open options page
chrome.runtime.onInstalled.addListener((details) => {
  if (details && details.reason === "install") {
    openOptionsPage();
  }
});

// Toolbar icon click:
// - If NOT one of the 3 supported sites → open options.
// - If it IS supported → ask content script to scrape.
//   Content script will send VD_SCRAPE_RESULT; we save it, then:
//     * if success: open options
//     * if failure: show dialog in page asking if they still want to open
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id || !tab.url) {
    openOptionsPage();
    return;
  }

  let urlObj;
  try {
    urlObj = new URL(tab.url);
  } catch {
    openOptionsPage();
    return;
  }

  const host = urlObj.host || "";
  const isSupported =
    host.includes("trainerroad.com") ||
    host.includes("trainerday.com") ||
    host.includes("whatsonzwift.com");

  if (!isSupported) {
    // Any other site → just open options
    openOptionsPage();
    return;
  }

  // Supported site: ask the content script to scrape this workout page.
  // Fire-and-forget: we don't use a callback, so Chrome won't complain about
  // "message port closed before a response was received".
  chrome.tabs.sendMessage(tab.id, {type: "VD_SCRAPE_WORKOUT"});
});

// ---------------- Message handling ----------------

chrome.runtime.onMessage.addListener((msg, sender, _sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "VD_SCRAPE_RESULT" && msg.payload) {
    const payload = msg.payload;
    const tabId = sender && sender.tab && sender.tab.id;

    (async () => {
      try {
        // Always record the attempt (success or failure)
        await saveScrapeResult(payload);
      } catch (err) {
        console.error("[VeloDrive] Failed to save scrape result:", err);
      }

      // If scrape succeeded, just open VeloDrive.
      if (payload.success) {
        openOptionsPage();
        return;
      }

      // Scrape failed on a supported site: show dialog with error and
      // ask if they still want to open VeloDrive.
      if (!tabId) {
        // No tab to show a dialog on; just open options as a fallback.
        openOptionsPage();
        return;
      }

      chrome.tabs.sendMessage(
        tabId,
        {
          type: "VD_SCRAPE_FAILED_PROMPT",
          error: payload.error || "",
          source: payload.source || "",
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[VeloDrive] Could not show failure prompt:",
              chrome.runtime.lastError.message
            );
            // If we can't show a prompt, safest is to just open VeloDrive.
            openOptionsPage();
            return;
          }

          if (response && response.openOptions) {
            openOptionsPage();
          }
          // If user chose "Cancel" or no response, do nothing.
        }
      );
    })();
  }
});

