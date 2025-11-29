// settings.js
// Settings modal for VeloDrive.
//
// Responsibilities:
//  - Show & manage settings modal (similar style to workout picker)
//  - Configure workout history dir + workout library (.zwo) dir
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

// --------------------------- Local state ---------------------------

let settingsInitialised = false;
let engine = null;

// Track whether we auto-opened because of some issue
let startupNeedsAttention = {
  missingHistoryDir: false,
  missingZwoDir: false,
  missingBtSupport: false,
};

// --------------------------- Utility helpers ---------------------------

function isWebBluetoothAvailable() {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.bluetooth &&

    // New Bluetooth Devices API capabilities
    typeof navigator.bluetooth.getDevices === "function"
  );
}

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
      historyDirStatusEl.classList.add("settings-status-ok");
    } else {
      historyDirStatusEl.textContent = "Not configured";
      historyDirStatusEl.classList.remove("settings-status-ok");
      historyDirStatusEl.classList.add("settings-status-missing");
      startupNeedsAttention.missingHistoryDir = true;
    }

    if (zwoHandle) {
      const name = zwoHandle.name || "Selected folder";
      zwoDirStatusEl.textContent = name;
      zwoDirStatusEl.classList.remove("settings-status-missing");
      zwoDirStatusEl.classList.add("settings-status-ok");
    } else {
      zwoDirStatusEl.textContent = "Not configured";
      zwoDirStatusEl.classList.remove("settings-status-ok");
      zwoDirStatusEl.classList.add("settings-status-missing");
      startupNeedsAttention.missingZwoDir = true;
    }
  } catch (err) {
    console.error("[Settings] Failed to load directory handles", err);
    historyDirStatusEl.textContent = "Error loading folder";
    zwoDirStatusEl.textContent = "Error loading folder";
    historyDirStatusEl.classList.remove("settings-status-ok");
    zwoDirStatusEl.classList.remove("settings-status-ok");
    historyDirStatusEl.classList.add("settings-status-missing");
    zwoDirStatusEl.classList.add("settings-status-missing");
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
    issues.push("Use a supported browser with Web Bluetooth (Chrome on desktop/Android).");
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
      // When manually opened, clear startup flags on banner
      startupNeedsAttention = {
        missingHistoryDir: false,
        missingZwoDir: false,
        missingBtSupport: false,
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

  const shouldShowFileHelp =
    startupNeedsAttention.missingHistoryDir ||
    startupNeedsAttention.missingZwoDir;
  const shouldShowBtHelp = startupNeedsAttention.missingBtSupport;

  // Auto-open settings if we detect critical missing configuration
  const shouldAutoOpen = shouldShowFileHelp || shouldShowBtHelp;

  if (shouldAutoOpen) {
    openSettings();

    // If file dirs are missing, open file help by default
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

