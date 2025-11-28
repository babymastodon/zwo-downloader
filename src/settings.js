// settings.js
// Settings modal for VeloDrive.
//
// Responsibilities:
//  - Show & manage settings modal (similar style to workout picker)
//  - Configure workout history dir + workout library (.zwo) dir
//  - FTP setting (editable input)
//  - Sound on/off toggle (replaces nav sound button)
//  - Logs view (replaces old logs overlay; preserves selection when appending)
//  - Environment checks: Web Bluetooth support + browser support
//
// This module assumes the HTML provides a settings overlay/modal with IDs
// referenced below (settingsOverlay, settingsModal, etc).
// It is designed to be initialised from workout.js via initSettings().

import {getWorkoutEngine} from "./workout-engine.js";
import {DEFAULT_FTP} from "./workout-metrics.js";

// NOTE: These helpers must exist in storage.js. If your actual names differ,
// adjust the imports or wrap them there.
import {
  loadSoundPreference,
  saveSoundPreference,
  saveFtp,
  loadWorkoutDirHandle,
  loadZwoDirHandle,
  ensureWorkoutDir,          // selects / re-permissions history dir
  ensureZwoDirectoryHandle,  // selects / re-permissions ZWO dir
} from "./storage.js";

// --------------------------- DOM refs ---------------------------

// Overlay + modal
const settingsOverlay = document.getElementById("settingsOverlay");
const settingsModal = document.getElementById("settingsModal");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const settingsOpenBtn = document.getElementById("settingsBtn");

// Views inside modal
const settingsMainView = document.getElementById("settingsMainView");
const settingsLogsView = document.getElementById("settingsLogsView");
const settingsOpenLogsBtn = document.getElementById("settingsOpenLogsBtn");
const settingsBackFromLogsBtn = document.getElementById("settingsBackFromLogsBtn");
const settingsLogsContent = document.getElementById("settingsLogsContent");

// Attention banner (for startup guidance)
const settingsAttentionBanner = document.getElementById("settingsAttentionBanner");

// Directories
const historyDirStatusEl = document.getElementById("historyDirStatus");
const historyDirButton = document.getElementById("historyDirButton");

const zwoDirStatusEl = document.getElementById("zwoDirStatus");
const zwoDirButton = document.getElementById("zwoDirButton");

// FTP
const ftpInput = document.getElementById("settingsFtpInput");
const ftpSaveBtn = document.getElementById("settingsFtpSaveBtn");
const ftpErrorEl = document.getElementById("settingsFtpError");

// Sound toggle (slider)
const soundToggleRoot = document.getElementById("settingsSoundToggle");
const soundCheckbox = document.getElementById("settingsSoundCheckbox");

// Environment status
const btStatusText = document.getElementById("settingsBtStatusText");
const btStatusCta = document.getElementById("settingsBtStatusCta");

const browserStatusText = document.getElementById("settingsBrowserStatusText");
const browserStatusCta = document.getElementById("settingsBrowserStatusCta");

// Help / user-guide toggles
const helpToggleButtons = Array.from(
  document.querySelectorAll("[data-settings-help-toggle]")
);

// --------------------------- Local state ---------------------------

let settingsInitialised = false;
let engine = null;

// Track whether we auto-opened because of some issue
let startupNeedsAttention = {
  missingHistoryDir: false,
  missingZwoDir: false,
  missingBtSupport: false,
  unsupportedBrowser: false,
};

// --------------------------- Utility helpers ---------------------------

function openSettings() {
  if (!settingsOverlay || !settingsModal) return;
  settingsOverlay.style.display = "flex";
  settingsModal.focus?.();
}

function closeSettings() {
  if (!settingsOverlay) return;
  settingsOverlay.style.display = "none";
  // When closing, show main view again
  showMainView();
}

function showMainView() {
  if (settingsMainView) settingsMainView.style.display = "";
  if (settingsLogsView) settingsLogsView.style.display = "none";
}

function showLogsView() {
  if (settingsMainView) settingsMainView.style.display = "none";
  if (settingsLogsView) settingsLogsView.style.display = "flex";
}

// Simple browser support heuristic: Chrome / Chromium / Edge-ish
function getBrowserSupportInfo() {
  if (typeof navigator === "undefined") {
    return {isSupported: false, name: "Unknown", reason: "No navigator"};
  }
  const ua = navigator.userAgent || "";
  const isEdge = /Edg\//.test(ua);
  const isChrome = /Chrome\//.test(ua) && !/OPR\//.test(ua) && !isEdge;
  const isChromiumLike = isChrome || isEdge;

  let name = "Unknown browser";
  if (isChrome) name = "Google Chrome";
  else if (isEdge) name = "Microsoft Edge";

  return {
    isSupported: isChromiumLike,
    name,
    reason: isChromiumLike
      ? ""
      : "VeloDrive works best in a Chromium-based browser such as Chrome or Edge.",
  };
}

function isWebBluetoothAvailable() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

// --------------------------- Logs handling ---------------------------
//
// Important: we append to the log view without resetting textContent,
// so any selection the user has stays intact.

export function addLogLineToSettings(line) {
  if (!settingsLogsContent) return;

  const atBottom =
    settingsLogsContent.scrollTop + settingsLogsContent.clientHeight >=
    settingsLogsContent.scrollHeight - 4;

  const needsNewline = settingsLogsContent.childNodes.length > 0;
  const text = (needsNewline ? "\n" : "") + line;

  settingsLogsContent.appendChild(document.createTextNode(text));

  if (atBottom) {
    settingsLogsContent.scrollTop = settingsLogsContent.scrollHeight;
  }
}

// --------------------------- Directories section ---------------------------

async function refreshDirectoryStatuses() {
  if (!historyDirStatusEl || !zwoDirStatusEl) return;

  try {
    const [historyHandle, zwoHandle] = await Promise.all([
      loadWorkoutDirHandle?.() ?? null,
      loadZwoDirHandle?.() ?? null,
    ]);

    if (historyHandle) {
      const name = historyHandle.name || "Selected folder";
      historyDirStatusEl.textContent = name;
      historyDirStatusEl.classList.remove("settings-status-missing");
    } else {
      historyDirStatusEl.textContent = "Not configured";
      historyDirStatusEl.classList.add("settings-status-missing");
      startupNeedsAttention.missingHistoryDir = true;
    }

    if (zwoHandle) {
      const name = zwoHandle.name || "Selected folder";
      zwoDirStatusEl.textContent = name;
      zwoDirStatusEl.classList.remove("settings-status-missing");
    } else {
      zwoDirStatusEl.textContent = "Not configured";
      zwoDirStatusEl.classList.add("settings-status-missing");
      startupNeedsAttention.missingZwoDir = true;
    }
  } catch (err) {
    console.error("[Settings] Failed to load directory handles", err);
    historyDirStatusEl.textContent = "Error loading folder";
    zwoDirStatusEl.textContent = "Error loading folder";
  }
}

async function handleChooseHistoryDir() {
  if (typeof ensureWorkoutDir !== "function") {
    alert("Folder selection is not available in this build.");
    return;
  }
  try {
    const handle = await ensureWorkoutDir();
    if (!handle) return;
    await refreshDirectoryStatuses();
  } catch (err) {
    console.error("[Settings] Failed to choose history folder:", err);
    alert("Failed to choose workout history folder.");
  }
}

async function handleChooseZwoDir() {
  if (typeof ensureZwoDirectoryHandle !== "function") {
    alert("Folder selection is not available in this build.");
    return;
  }
  try {
    const handle = await ensureZwoDirectoryHandle();
    if (!handle) return;
    await refreshDirectoryStatuses();
  } catch (err) {
    console.error("[Settings] Failed to choose ZWO folder:", err);
    alert("Failed to choose workout library (.zwo) folder.");
  }
}

// --------------------------- FTP section ---------------------------

function refreshFtpFromEngine() {
  if (!ftpInput) return;
  if (!engine) engine = getWorkoutEngine();
  const vm = engine.getViewModel();
  const current = vm.currentFtp || DEFAULT_FTP;
  ftpInput.value = String(current);
  if (ftpErrorEl) ftpErrorEl.textContent = "";
}

function handleFtpSave() {
  if (!ftpInput || !engine) return;

  const raw = ftpInput.value.trim();
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    if (ftpErrorEl) ftpErrorEl.textContent = "Enter a number between 50 and 500.";
    return;
  }
  const clamped = Math.min(500, Math.max(50, Math.round(n)));
  if (ftpErrorEl) ftpErrorEl.textContent = "";

  const vm = engine.getViewModel();
  if (clamped === vm.currentFtp) return;

  engine.setFtp(clamped);
  try {
    saveFtp(clamped);
  } catch (err) {
    console.error(
      "[Settings] Failed to persist FTP to chrome.storage.sync:",
      err
    );
  }
}

// --------------------------- Sound section ---------------------------

async function refreshSoundToggle() {
  if (!soundCheckbox) return;
  const initial = await loadSoundPreference(true);
  soundCheckbox.checked = !!initial;
}

function handleSoundToggleChanged() {
  if (!soundCheckbox) return;
  const enabled = !!soundCheckbox.checked;
  saveSoundPreference(enabled).catch?.((err) => {
    console.error("[Settings] Failed to save sound preference:", err);
  });
}

// --------------------------- Environment checks ---------------------------

function refreshEnvironmentStatus() {
  // Browser
  if (browserStatusText || browserStatusCta) {
    const info = getBrowserSupportInfo();
    if (browserStatusText) {
      browserStatusText.textContent = info.isSupported
        ? `${info.name} detected`
        : `Current browser: ${info.name}`;
      browserStatusText.classList.toggle("settings-status-ok", info.isSupported);
      browserStatusText.classList.toggle("settings-status-missing", !info.isSupported);
    }

    if (browserStatusCta) {
      if (info.isSupported) {
        browserStatusCta.style.display = "none";
      } else {
        browserStatusCta.style.display = "";
      }
    }

    if (!info.isSupported) {
      startupNeedsAttention.unsupportedBrowser = true;
    }
  }

  // Web Bluetooth
  const hasBt = isWebBluetoothAvailable();
  if (btStatusText) {
    btStatusText.textContent = hasBt
      ? "Web Bluetooth available"
      : "Web Bluetooth not available in this environment";
    btStatusText.classList.toggle("settings-status-ok", hasBt);
    btStatusText.classList.toggle("settings-status-missing", !hasBt);
  }

  if (btStatusCta) {
    if (hasBt) {
      btStatusCta.style.display = "none";
    } else {
      btStatusCta.style.display = "";
    }
  }

  if (!hasBt) {
    startupNeedsAttention.missingBtSupport = true;
  }
}

// --------------------------- Attention banner ---------------------------

function updateAttentionBanner() {
  if (!settingsAttentionBanner) return;

  const issues = [];
  if (startupNeedsAttention.missingHistoryDir || startupNeedsAttention.missingZwoDir) {
    issues.push("Select workout history & library folders.");
  }
  if (startupNeedsAttention.missingBtSupport) {
    issues.push("Enable Web Bluetooth (see instructions below).");
  }
  if (startupNeedsAttention.unsupportedBrowser) {
    issues.push("Use a Chromium-based browser such as Chrome or Edge.");
  }

  if (!issues.length) {
    settingsAttentionBanner.style.display = "none";
    settingsAttentionBanner.textContent = "";
    return;
  }

  settingsAttentionBanner.style.display = "block";
  settingsAttentionBanner.textContent =
    "Before you start: " + issues.join(" ");
}

// --------------------------- Help / user-guide toggles ---------------------------

function initHelpToggles() {
  if (!helpToggleButtons.length) return;
  helpToggleButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-settings-help-toggle");
      if (!targetId) return;
      const el = document.getElementById(targetId);
      if (!el) return;
      const isHidden = el.hasAttribute("hidden");
      if (isHidden) {
        el.removeAttribute("hidden");
      } else {
        el.setAttribute("hidden", "true");
      }
    });
  });
}

// --------------------------- Event wiring ---------------------------

function wireSettingsEvents() {
  if (settingsOpenBtn) {
    settingsOpenBtn.addEventListener("click", () => {
      // When manually opened, clear startup flags on banner
      startupNeedsAttention = {
        missingHistoryDir: false,
        missingZwoDir: false,
        missingBtSupport: false,
        unsupportedBrowser: false,
      };
      updateAttentionBanner();
      openSettings();
    });
  }

  if (settingsCloseBtn) {
    settingsCloseBtn.addEventListener("click", () => {
      closeSettings();
    });
  }

  if (settingsOverlay && settingsModal) {
    settingsOverlay.addEventListener("click", (e) => {
      if (e.target === settingsOverlay) {
        closeSettings();
      }
    });
  }

  if (settingsOpenLogsBtn) {
    settingsOpenLogsBtn.addEventListener("click", () => {
      showLogsView();
    });
  }

  if (settingsBackFromLogsBtn) {
    settingsBackFromLogsBtn.addEventListener("click", () => {
      showMainView();
    });
  }

  if (historyDirButton) {
    historyDirButton.addEventListener("click", () => {
      handleChooseHistoryDir();
    });
  }

  if (zwoDirButton) {
    zwoDirButton.addEventListener("click", () => {
      handleChooseZwoDir();
    });
  }

  if (ftpSaveBtn && ftpInput) {
    ftpSaveBtn.addEventListener("click", () => {
      handleFtpSave();
    });
    // Optional convenience: Enter key in FTP input
    ftpInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleFtpSave();
      }
    });
  }

  if (soundCheckbox && soundToggleRoot) {
    soundCheckbox.addEventListener("change", () => {
      handleSoundToggleChanged();
    });
  }

  // ESC key to close settings / exit logs view
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (settingsOverlay && settingsOverlay.style.display === "flex") {
        if (settingsLogsView && settingsLogsView.style.display !== "none") {
          showMainView();
        } else {
          closeSettings();
        }
      }
    }
  });
}

// --------------------------- Public init ---------------------------

export async function initSettings() {
  if (settingsInitialised) return;
  settingsInitialised = true;

  engine = getWorkoutEngine();

  wireSettingsEvents();
  initHelpToggles();

  // Initial data
  await Promise.all([
    refreshDirectoryStatuses(),
    refreshSoundToggle(),
  ]);

  refreshFtpFromEngine();
  refreshEnvironmentStatus();
  updateAttentionBanner();

  // Auto-open settings if we detect critical missing configuration
  const shouldAutoOpen =
    startupNeedsAttention.missingHistoryDir ||
    startupNeedsAttention.missingZwoDir ||
    startupNeedsAttention.missingBtSupport ||
    startupNeedsAttention.unsupportedBrowser;

  if (shouldAutoOpen) {
    openSettings();
  }
}

