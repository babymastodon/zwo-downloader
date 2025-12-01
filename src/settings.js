// settings.js
// Settings modal for VeloDrive.
//
// Responsibilities:
//  - Show & manage settings modal (similar style to workout picker)
//  - Configure root VeloDrive data folder (workouts + history + trash)
//  - FTP setting (FTP control-group with +/-10 buttons, saves on Enter/blur, no Save button)
//  - Sound on/off toggle (replaces nav sound button)
//  - Logs view (replaces old logs overlay; preserves selection when appending)
//  - Environment checks: Web Bluetooth support + browser support
//
// This module assumes the HTML provides a settings overlay/modal with IDs
// referenced below (settingsOverlay, settingsModal, etc).
// It is designed to be initialised from workout.js via initSettings().

import {getWorkoutEngine} from "./workout-engine.js";
import {DEFAULT_FTP} from "./workout-metrics.js";

import {
  loadSoundPreference,
  saveSoundPreference,
  saveFtp,
  loadRootDirHandle,
  pickRootDir,          // selects / re-permissions the single root dir
} from "./storage.js";

// --------------------------- DOM refs ---------------------------

// Overlay + modal
const settingsOverlay = document.getElementById("settingsOverlay");
const settingsModal = document.getElementById("settingsModal");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const settingsOpenBtn = document.getElementById("settingsBtn");
const settingsTitleEl = document.getElementById("settingsTitle");
const settingsSubtitleEl = document.getElementById("settingsSubtitle");

// Views inside modal
const settingsMainView = document.getElementById("settingsMainView");
const settingsLogsView = document.getElementById("settingsLogsView");
const settingsOpenLogsBtn = document.getElementById("settingsOpenLogsBtn");
const settingsBackFromLogsBtn = document.getElementById("settingsBackFromLogsBtn");
const settingsLogsContent = document.getElementById("settingsLogsContent");

// Attention banner (for startup guidance)
const settingsAttentionBanner = document.getElementById("settingsAttentionBanner");

// Root directory (single picker)
const rootDirStatusEl = document.getElementById("rootDirStatus");
const rootDirButton = document.getElementById("rootDirButton");

// FTP
const ftpInput = document.getElementById("settingsFtpInput");
const ftpDeltaButtons = Array.from(
  document.querySelectorAll("[data-ftp-delta]")
);

// Sound toggle (slider)
const soundToggleRoot = document.getElementById("settingsSoundToggle");
const soundCheckbox = document.getElementById("settingsSoundCheckbox");

// Environment status
const btStatusText = document.getElementById("settingsBtStatusText");

// Help / user-guide toggles
const helpToggleButtons = Array.from(
  document.querySelectorAll("[data-settings-help-toggle]")
);

const SETTINGS_TITLE_TEXT = "Settings";
const SETTINGS_SUBTITLE_TEXT =
  "Configure folders, FTP, sound, logs, and environment checks.";

const LOGS_TITLE_TEXT = "Connection logs";
const LOGS_SUBTITLE_TEXT = "Real-time connection and Bluetooth logs.";

// --------------------------- Local state ---------------------------

let settingsInitialised = false;
let engine = null;

// Track whether we auto-opened because of some issue
let startupNeedsAttention = {
  missingRootDir: false,
  missingBtSupport: false,
};

// If true, the user isn't allowed to dismiss the Settings modal
let hasBlockingSettingsIssues = false;

// --------------------------- Utility helpers ---------------------------

function isWebBluetoothAvailable() {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.bluetooth &&
    typeof navigator.bluetooth.getDevices === "function"
  );
}

function openSettings() {
  if (!settingsOverlay || !settingsModal) return;
  settingsOverlay.style.display = "flex";
}

function actuallyCloseSettings() {
  if (!settingsOverlay) return;
  settingsOverlay.style.display = "none";
  // When closing, show main view again
  showMainView();
}

function canDismissSettings() {
  if (!hasBlockingSettingsIssues) return true;

  alert("Please fix the highlighted settings before closing the Settings window.");
  return false;
}

function closeSettings() {
  if (!canDismissSettings()) return;
  actuallyCloseSettings();
}

function showMainView() {
  if (!settingsMainView || !settingsLogsView) return;

  settingsMainView.style.display = "";
  settingsLogsView.style.display = "none";

  if (settingsTitleEl) {
    settingsTitleEl.textContent = SETTINGS_TITLE_TEXT;
  }
  if (settingsSubtitleEl) {
    settingsSubtitleEl.textContent = SETTINGS_SUBTITLE_TEXT;
  }

  if (settingsBackFromLogsBtn) {
    settingsBackFromLogsBtn.style.display = "none";
  }
}

function showLogsView() {
  if (!settingsMainView || !settingsLogsView) return;

  settingsMainView.style.display = "none";
  settingsLogsView.style.display = "flex";

  if (settingsTitleEl) {
    settingsTitleEl.textContent = LOGS_TITLE_TEXT;
  }
  if (settingsSubtitleEl) {
    settingsSubtitleEl.textContent = LOGS_SUBTITLE_TEXT;
  }

  if (settingsBackFromLogsBtn) {
    settingsBackFromLogsBtn.style.display = "inline-flex";
  }

  requestAnimationFrame(() => {
    if (!settingsLogsContent) return;
    settingsLogsContent.scrollTop = settingsLogsContent.scrollHeight;
  });
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
  if (!rootDirStatusEl) return;

  try {
    const rootHandle =
      typeof loadRootDirHandle === "function" ? await loadRootDirHandle() : null;

    if (rootHandle) {
      const name = rootHandle.name || "Selected folder";
      rootDirStatusEl.textContent = name;
      rootDirStatusEl.classList.remove("settings-status-missing");
      rootDirStatusEl.classList.add("settings-status-ok");
      startupNeedsAttention.missingRootDir = false;
    } else {
      rootDirStatusEl.textContent = "Not configured";
      rootDirStatusEl.classList.remove("settings-status-ok");
      rootDirStatusEl.classList.add("settings-status-missing");
      startupNeedsAttention.missingRootDir = true;
    }
  } catch (err) {
    console.error("[Settings] Failed to load root directory handle", err);
    rootDirStatusEl.textContent = "Error loading folder";
    rootDirStatusEl.classList.remove("settings-status-ok");
    rootDirStatusEl.classList.add("settings-status-missing");

    // Treat as blocking
    startupNeedsAttention.missingRootDir = true;
  }
}

async function handleChooseRootDir() {
  if (typeof pickRootDir !== "function") {
    alert("Folder selection is not available in this build.");
    return;
  }
  try {
    const handle = await pickRootDir();
    if (!handle) return;
    await refreshDirectoryStatuses();
    updateAttentionBanner();
  } catch (err) {
    console.error("[Settings] Failed to choose VeloDrive folder:", err);
    alert("Failed to choose VeloDrive folder.");
  }
}

// --------------------------- FTP section ---------------------------

function getEngine() {
  if (!engine) {
    engine = getWorkoutEngine();
  }
  return engine;
}

function getCurrentFtpFromEngine() {
  const eng = getEngine();
  const vm = eng.getViewModel();
  return vm.currentFtp || DEFAULT_FTP;
}

function refreshFtpFromEngine() {
  if (!ftpInput) return;
  const current = getCurrentFtpFromEngine();
  ftpInput.value = String(current);
}

function normaliseFtpValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 250;
  const clamped = Math.min(500, Math.max(50, Math.round(n)));
  return clamped;
}

function applyFtpValue(newFtp) {
  const eng = getEngine();
  if (!eng) return;

  const vm = eng.getViewModel();
  if (newFtp === vm.currentFtp) {
    // Nothing to do.
    return;
  }

  eng.setFtp(newFtp);
  if (ftpInput) {
    ftpInput.value = String(newFtp);
  }
  try {
    saveFtp(newFtp);
  } catch (err) {
    console.error("[Settings] Failed to persist FTP to storage:", err);
  }
}

function handleFtpSave() {
  if (!ftpInput) return;

  const raw = ftpInput.value.trim();
  const normalised = normaliseFtpValue(raw);
  applyFtpValue(normalised);
}

function handleFtpDelta(delta) {
  if (!ftpInput) return;

  const engineFtp = getCurrentFtpFromEngine();
  const currentParsed = normaliseFtpValue(ftpInput.value.trim());
  const base = currentParsed == null ? engineFtp : currentParsed;
  const next = normaliseFtpValue(base + delta);
  if (next == null) return;
  applyFtpValue(next);
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
  const hasBt = isWebBluetoothAvailable();

  if (btStatusText) {
    btStatusText.textContent = hasBt
      ? "Web Bluetooth API detected in this browser."
      : "Web Bluetooth API not detected.";
    btStatusText.classList.toggle("settings-status-ok", hasBt);
    btStatusText.classList.toggle("settings-status-missing", !hasBt);
  }

  startupNeedsAttention.missingBtSupport = !hasBt;
}

// --------------------------- Attention banner ---------------------------

function updateAttentionBanner() {
  if (!settingsAttentionBanner) return;

  const issues = [];

  if (startupNeedsAttention.missingRootDir) {
    issues.push("Choose a VeloDrive folder for your workouts and history.");
  }
  if (startupNeedsAttention.missingBtSupport) {
    issues.push("Use a supported browser with Web Bluetooth (Chrome on desktop/Android).");
  }

  // Any of these issues are now considered blocking, including Bluetooth.
  hasBlockingSettingsIssues =
    startupNeedsAttention.missingRootDir ||
    startupNeedsAttention.missingBtSupport;

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

// Helper to force a specific help section visible (used on startup issues)
function showHelpSectionById(targetId) {
  if (!targetId) return;
  const el = document.getElementById(targetId);
  if (!el) return;

  const wasHidden = el.hasAttribute("hidden");
  if (wasHidden) {
    el.removeAttribute("hidden");
  }

  // Replay the CSS transition used in initHelpToggles
  el.classList.remove("settings-help-content--visible");
  // eslint-disable-next-line no-unused-expressions
  el.offsetWidth;
  el.classList.add("settings-help-content--visible");
}

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
        // Show with a small fade/slide animation
        el.removeAttribute("hidden");
        el.classList.remove("settings-help-content--visible");
        // Force reflow so the animation can replay
        // eslint-disable-next-line no-unused-expressions
        el.offsetWidth;
        el.classList.add("settings-help-content--visible");
      } else {
        el.setAttribute("hidden", "true");
        el.classList.remove("settings-help-content--visible");
      }
    });
  });
}

// --------------------------- Event wiring ---------------------------

function wireSettingsEvents() {
  if (settingsOpenBtn) {
    settingsOpenBtn.addEventListener("click", () => {
      // Don't reset error flags; they reflect real config state.
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

  if (rootDirButton) {
    rootDirButton.addEventListener("click", () => {
      handleChooseRootDir();
    });
  }

  if (ftpInput) {
    // Save on Enter and blur, then blur on Enter
    ftpInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleFtpSave();
        ftpInput.blur();
      }
    });

    ftpInput.addEventListener("blur", () => {
      handleFtpSave();
    });
  }

  if (ftpDeltaButtons.length) {
    ftpDeltaButtons.forEach((btn) => {
      const delta = Number(btn.getAttribute("data-ftp-delta") || "0");
      if (!Number.isFinite(delta) || !delta) return;
      btn.addEventListener("click", () => {
        handleFtpDelta(delta);
      });
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

  const shouldShowFileHelp = startupNeedsAttention.missingRootDir;
  const shouldShowBtHelp = startupNeedsAttention.missingBtSupport;

  // Auto-open settings if we detect critical missing configuration
  const shouldAutoOpen = shouldShowFileHelp || shouldShowBtHelp;

  if (shouldAutoOpen) {
    openSettings();

    // If root dir is missing, open file help by default
    // (expects a help section with ID "settingsFoldersHelp" in the DOM)
    if (shouldShowFileHelp) {
      showHelpSectionById("settingsFoldersHelp");
    }

    // If Bluetooth support is missing, open Bluetooth help by default
    // (expects a help section with ID "settingsEnvHelp" in the DOM)
    if (shouldShowBtHelp) {
      showHelpSectionById("settingsEnvHelp");
    }
  }
}
