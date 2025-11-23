// background.js (MV3 service worker)

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

