// welcome.js
// First-run welcome / tour overlay for VeloDrive.

const SLIDES = [
  {
    id: "splash",
    kind: "splash", // logo + text only
    title: "Welcome to VeloDrive",
    bodyLines: [
      "Indoor bike workouts that run directly in your browser.",
      "Tap or press \u2192 to continue.",
    ],
    videoLight: null,
    videoDark: null,
  },
  {
    id: "trainers",
    kind: "video",
    title: "Ride structured workouts on your smart trainer",
    bodyLines: [
      "Connect to FTMS trainers like Wahoo KICKR, Tacx Neo, and similar devices, plus Bluetooth heart-rate sensors.",
      "Control ERG or resistance from the browser and see live power, heart rate, cadence, and time.",
    ],
    videoLight: "media/welcome-trainers-light.webm",
    videoDark: "media/welcome-trainers-dark.webm",
  },
  {
    id: "offline",
    kind: "video",
    title: "Local data. Offline workouts.",
    bodyLines: [
      "Install VeloDrive as a Progressive Web App so it runs like a native application.",
      "Workouts and history are stored on your filesystem, so you can ride with no internet connection.",
    ],
    videoLight: "media/welcome-offline-light.webm",
    videoDark: "media/welcome-offline-dark.webm",
  },
  {
    id: "workouts",
    kind: "video",
    title: "Use community workouts or build your own",
    bodyLines: [
      "Import workouts from TrainerRoad, TrainerDay, and Zwift collections.",
      "Export them as .zwo or .fit files, or build your own sessions from scratch.",
    ],
    videoLight: "media/welcome-workouts-light.webm",
    videoDark: "media/welcome-workouts-dark.webm",
  },
  {
    id: "get-started",
    kind: "get-started", // icon row, no video, detail on hover
    title: "Get started in three steps",
    bodyLines: [], // no default text; details appear on hover
    videoLight: null,
    videoDark: null,
  },
];

const STEP_DETAILS = {
  folder:
    "Select a folder on your filesystem where VeloDrive can read and write workouts and history. Cloud-synced folders work too.",
  trainer:
    "Use the Bike and HR buttons in the bottom bar to connect your FTMS trainer and heart-rate monitor over Bluetooth.",
  workout:
    "Open the workout library to import a workout from TrainerRoad, TrainerDay, Zwift collections, or your own .zwo files.",
};

function getCurrentColorScheme() {
  if (!window.matchMedia) return "light";
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  return mql.matches ? "dark" : "light";
}

export function initWelcomeTour(options = {}) {
  const {onFinished, onVisibilityChanged} = options;

  const overlay = document.getElementById("welcomeOverlay");
  const titleEl = document.getElementById("welcomeTitle");
  const bodyEl = document.getElementById("welcomeBody");
  const videoEl = document.getElementById("welcomeVideo");
  const logoEl = document.getElementById("welcomeLogo");
  const iconRowEl = document.getElementById("welcomeIconRow");
  const stepDetailEl = document.getElementById("welcomeStepDetail");

  const prevBtn = document.getElementById("welcomePrevBtn");
  const nextBtn = document.getElementById("welcomeNextBtn");
  const closeBtn = document.getElementById("welcomeCloseBtn");
  const slideContainer = overlay
    ? overlay.querySelector(".welcome-slide")
    : null;

  const stepFolderCard = document.getElementById("welcomeStepFolder");
  const stepTrainerCard = document.getElementById("welcomeStepTrainer");
  const stepWorkoutCard = document.getElementById("welcomeStepWorkout");

  if (
    !overlay ||
    !titleEl ||
    !bodyEl ||
    !videoEl ||
    !logoEl ||
    !iconRowEl ||
    !stepDetailEl ||
    !slideContainer ||
    !stepFolderCard ||
    !stepTrainerCard ||
    !stepWorkoutCard
  ) {
    console.warn("[Welcome] Required DOM elements not found; tour disabled.");
    return {
      open() {},
      close() {},
      goToSlide() {},
      playSplash() {},
    };
  }

  let currentIndex = 0;
  let isOpen = false;
  let isAnimating = false;
  let scheme = getCurrentColorScheme();
  let currentMode = "full"; // "full" | "splash"
  let autoCloseTimer = null;

  const visibilityCb =
    typeof onVisibilityChanged === "function" ? onVisibilityChanged : null;

  function notifyVisibility(isVisible) {
    if (visibilityCb) {
      visibilityCb({isOpen: isVisible, mode: currentMode});
    }
  }

  function clearAutoClose() {
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
  }

  function setOverlayMode(mode) {
    currentMode = mode === "splash" ? "splash" : "full";
    overlay.classList.toggle(
      "welcome-overlay--splash-only",
      currentMode === "splash"
    );
  }

  const mqlDark = window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

  function computeBodyHtml(lines) {
    if (!lines || !lines.length) return "";
    return lines
      .map((line) => `<span class="welcome-body-line">${line}</span>`)
      .join("<br>");
  }

  function hideAllMedia() {
    logoEl.style.display = "none";
    videoEl.style.display = "none";
    iconRowEl.style.display = "none";
    videoEl.removeAttribute("src");
    videoEl.load();
  }

  function showSplashLogo() {
    hideAllMedia();
    logoEl.style.display = "block";
  }

  function showGetStartedIcons() {
    hideAllMedia();
    iconRowEl.style.display = "flex";
    stepDetailEl.textContent = "";
    stepDetailEl.classList.remove("welcome-step-detail--visible");
  }

  function showVideoForSlide(slide) {
    if (!slide || !slide.videoLight || !slide.videoDark) {
      hideAllMedia();
      return;
    }

    const isDark = scheme === "dark";
    const src = isDark ? slide.videoDark : slide.videoLight;

    logoEl.style.display = "none";
    iconRowEl.style.display = "none";
    videoEl.style.display = "block";

    if (videoEl.getAttribute("src") === src) {
      return;
    }

    videoEl.setAttribute("src", src);
    videoEl.load();

    videoEl
      .play()
      .catch(() => {
        // Ignore autoplay failure.
      });
  }

  function updateMediaForSlide(slide) {
    if (slide.kind === "video") {
      showVideoForSlide(slide);
    } else if (slide.kind === "get-started") {
      showGetStartedIcons();
    } else {
      // splash / logo-only
      showSplashLogo();
    }
  }

  function applySlideClasses(slide) {
    slideContainer.classList.toggle("welcome-slide--splash", slide.kind === "splash");
    slideContainer.classList.toggle(
      "welcome-slide--icon-only",
      slide.kind === "splash" || slide.kind === "get-started"
    );
  }

  function renderSlide(index) {
    const slide = SLIDES[index];
    if (!slide) return;

    currentIndex = index;

    titleEl.textContent = slide.title;

    if (slide.kind === "get-started") {
      // No default body; details appear on hover
      bodyEl.innerHTML = "";
    } else {
      bodyEl.innerHTML = computeBodyHtml(slide.bodyLines);
    }

    applySlideClasses(slide);
    updateMediaForSlide(slide);

    if (prevBtn) {
      prevBtn.style.visibility = index === 0 ? "hidden" : "visible";
    }
    if (nextBtn) {
      nextBtn.style.visibility = "visible";
    }
  }

  function animateSlideChange(targetIndex, direction) {
    if (!slideContainer || targetIndex === currentIndex || isAnimating) {
      renderSlide(targetIndex);
      return;
    }

    isAnimating = true;

    const outDir = direction === "prev" ? 1 : -1;
    const inDir = -outDir;

    slideContainer.classList.add("welcome-slide--animating");
    slideContainer.style.transform = `translateX(${outDir * 12}px)`;
    slideContainer.style.opacity = "0";

    const handleOutEnd = () => {
      slideContainer.removeEventListener("transitionend", handleOutEnd);

      renderSlide(targetIndex);
      slideContainer.style.transition = "none";
      slideContainer.style.transform = `translateX(${inDir * 12}px)`;
      slideContainer.style.opacity = "0";

      // Force reflow
      // eslint-disable-next-line no-unused-expressions
      slideContainer.offsetWidth;

      slideContainer.style.transition = "";
      slideContainer.style.transform = "translateX(0)";
      slideContainer.style.opacity = "1";

      const handleInEnd = () => {
        slideContainer.removeEventListener("transitionend", handleInEnd);
        slideContainer.classList.remove("welcome-slide--animating");
        isAnimating = false;
      };

      slideContainer.addEventListener("transitionend", handleInEnd);
    };

    slideContainer.addEventListener("transitionend", handleOutEnd);
  }

  function closeOverlay() {
    if (!isOpen) return;
    clearAutoClose();
    isOpen = false;
    const wasSplash = currentMode === "splash";
    overlay.classList.add("welcome-overlay--hiding");
    overlay.classList.remove("welcome-overlay--visible");

    let done = false;
    const finalize = () => {
      if (done) return;
      done = true;
      overlay.removeEventListener("transitionend", finalize);
      overlay.style.display = "none";
      overlay.classList.remove(
        "welcome-overlay--visible",
        "welcome-overlay--hiding"
      );
      if (!wasSplash) {
        overlay.classList.remove("welcome-overlay--splash-only");
      }
      notifyVisibility(false);
      if (typeof onFinished === "function") {
        onFinished();
      }
    };

    // Keep splash-only visuals until fully hidden to avoid caret flashing in splash mode.

    overlay.addEventListener("transitionend", finalize);
    window.setTimeout(finalize, 260); // fallback if transitionend doesn’t fire
  }

  function openOverlay(startIndex = 0, opts = {}) {
    if (isOpen) return;
    clearAutoClose();
    const {mode = "full", autoCloseMs = null} =
      opts && typeof opts === "object" ? opts : {};
    setOverlayMode(mode);
    isOpen = true;

    if (startIndex < 0 || startIndex >= SLIDES.length) {
      startIndex = 0;
    }

    renderSlide(startIndex);

    overlay.style.display = "flex";
    overlay.classList.remove("welcome-overlay--hiding");

    notifyVisibility(true);

    requestAnimationFrame(() => {
      overlay.classList.add("welcome-overlay--visible");
    });

    if (autoCloseMs) {
      autoCloseTimer = window.setTimeout(() => {
        closeOverlay();
      }, autoCloseMs);
    }
  }

  function goToNext() {
    if (currentMode === "splash") return;
    if (currentIndex >= SLIDES.length - 1) {
      closeOverlay();
      return;
    }
    const nextIndex = currentIndex + 1;
    animateSlideChange(nextIndex, "next");
  }

  function goToPrev() {
    if (currentMode === "splash") return;
    if (currentIndex <= 0) return;
    const prevIndex = currentIndex - 1;
    animateSlideChange(prevIndex, "prev");
  }

  function handleOverlayClick(event) {
    if (!isOpen) return;
    if (currentMode === "splash") {
      event.stopPropagation();
      return;
    }

    const target = event.target;

    // Ignore clicks on controls or get-started icons
    if (
      target.closest(".welcome-nav") ||
      target.closest(".welcome-close-btn") ||
      target.closest(".welcome-icon-card")
    ) {
      return;
    }

    goToNext();
  }

  function handleKeydown(event) {
    if (!isOpen) return;
    event.stopPropagation();
    event.stopImmediatePropagation();

    const {key} = event;

    if (currentMode === "splash") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (key === "Escape") {
        closeOverlay();
      }
      return;
    }

    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeOverlay();
    } else if (key === "ArrowRight" || key === "PageDown") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      goToNext();
    } else if (key === "ArrowLeft" || key === "PageUp") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      goToPrev();
    } else if (key === " " || key === "Enter") {
      const active = document.activeElement;
      if (active === overlay || active === document.body) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        goToNext();
      }
    }
  }

  overlay.addEventListener("click", handleOverlayClick);

  if (prevBtn) {
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      goToPrev();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      goToNext();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeOverlay();
    });
  }

  document.addEventListener("keydown", handleKeydown);

  if (mqlDark && typeof mqlDark.addEventListener === "function") {
    mqlDark.addEventListener("change", (event) => {
      scheme = event.matches ? "dark" : "light";
      if (isOpen) {
        const slide = SLIDES[currentIndex];
        updateMediaForSlide(slide);
      }
    });
  }

  // Hover / focus details for get-started steps
  function showStepDetail(stepKey) {
    const text = STEP_DETAILS[stepKey];
    if (!text) return;
    stepDetailEl.textContent = text;
    stepDetailEl.classList.add("welcome-step-detail--visible");
  }

  function clearStepDetail() {
    stepDetailEl.classList.remove("welcome-step-detail--visible");
    stepDetailEl.textContent = "";
  }

  function wireStepCard(cardEl, stepKey) {
    const enterEvents = ["mouseenter", "focus"];
    const leaveEvents = ["mouseleave", "blur"];

    enterEvents.forEach((type) => {
      cardEl.addEventListener(type, (e) => {
        e.stopPropagation();
        showStepDetail(stepKey);
      });
    });

    leaveEvents.forEach((type) => {
      cardEl.addEventListener(type, (e) => {
        e.stopPropagation();
        clearStepDetail();
      });
    });

    cardEl.addEventListener("click", (e) => {
      // Clicking should not advance slides
      e.stopPropagation();
      showStepDetail(stepKey);
    });
  }

  wireStepCard(stepFolderCard, "folder");
  wireStepCard(stepTrainerCard, "trainer");
  wireStepCard(stepWorkoutCard, "workout");

  // Initial render (hidden until open())
  renderSlide(0);

  return {
    open: openOverlay,
    close: closeOverlay,
    playSplash(durationMs = 2000) {
      openOverlay(0, {mode: "splash", autoCloseMs: durationMs});
    },
    goToSlide(index) {
      if (index < 0 || index >= SLIDES.length) return;
      if (!isOpen) {
        openOverlay(index);
      } else {
        const dir = index > currentIndex ? "next" : "prev";
        animateSlideChange(index, dir);
      }
    },
  };
}
