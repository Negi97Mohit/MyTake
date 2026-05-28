// popup.js — MoodLens v2.0 Popup Controller
// Handles: mood grid, custom moods, auto/manual mode, AI commands

(() => {
  "use strict";

  // Establish connection to background to track popup open state
  try {
    chrome.runtime.connect({ name: "moodlens_popup" });
  } catch (_) {}

  // ── Built-in moods ────────────────────────────────────────────────────────
  const BUILTIN_MOODS = [
    { id: "standard", name: "Standard", desc: "Clean & neutral" },
    { id: "cherry", name: "Cherry", desc: "Warm & uplifting" },
    { id: "honest", name: "Honest", desc: "Direct, no fluff" },
    { id: "brutally-honest", name: "Brutal", desc: "Blunt & straight" },
    { id: "academic", name: "Academic", desc: "Formal & precise" },
    { id: "casual", name: "Casual", desc: "Chill & relaxed" },
    { id: "poetic", name: "Poetic", desc: "Evocative & rich" },
  ];

  // Curated gradient palette for custom moods
  const CUSTOM_GRADIENTS = [
    "linear-gradient(135deg, #f472b6, #a78bfa)",
    "linear-gradient(135deg, #fb923c, #facc15)",
    "linear-gradient(135deg, #34d399, #2dd4bf)",
    "linear-gradient(135deg, #60a5fa, #a78bfa)",
    "linear-gradient(135deg, #f87171, #fb923c)",
    "linear-gradient(135deg, #c084fc, #f0abfc)",
    "linear-gradient(135deg, #38bdf8, #34d399)",
    "linear-gradient(135deg, #fbbf24, #f472b6)",
  ];

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const $ = (sel) => document.getElementById(sel);
  const mainContent = $("main-content");
  const triggerBtn = $("trigger-btn");
  const dot = $("status-dot");
  const statusTx = $("status-text");
  const progressBar = $("progress-bar");
  const progressText = $("progress-text");
  const aiBanner = $("ai-banner");
  const aiDetail = $("ai-detail");

  // Apple Health Globe & Carousel
  const carouselTrack = $("carousel-track");
  const carouselPrev = $("carousel-prev");
  const carouselNext = $("carousel-next");
  const globeSphere = $("globe-sphere");
  const globeHue = $("globe-hue");
  const globeLabel = $("globe-label");
  const globeDesc = $("globe-desc");
  const themeToggleBtn = $("theme-toggle-btn");
  const degreeSlider = $("degree-slider");
  const intensityBadge = $("intensity-badge");

  // Pause/Resume/Restart Controls
  const pauseBtn = $("pause-btn");
  const restartBtn = $("restart-btn");

  // Commands
  const cmdInput = $("cmd-input");
  const cmdRunBtn = $("cmd-run-btn");
  const cmdList = $("cmd-list");
  const cmdBulkRow = $("cmd-bulk-row");
  const cmdRunSelected = $("cmd-run-selected");
  const cmdRunAll = $("cmd-run-all");

  // Modal
  const moodModal = $("mood-modal");
  const modalCancel = $("modal-cancel");
  const modalSave = $("modal-save");
  const customName = $("custom-mood-name");
  const customDesc = $("custom-mood-desc");

  // ── State ─────────────────────────────────────────────────────────────────
  let currentMood = "standard";
  let currentEnabled = true;
  let currentMode = "manual";
  let customMoods = [];
  let savedCommands = [];
  let currentIntensity = 2;
  let currentTheme = "dark";
  let currentPaused = false;
  let runStarted = false; // tracks if Run was ever pressed this session

  // ── Load state ────────────────────────────────────────────────────────────
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
    if (chrome.runtime.lastError) {
      console.error(
        "[MoodLens popup] GET_STATE error:",
        chrome.runtime.lastError,
      );
      return;
    }
    currentMood = state.mood || "standard";
    currentEnabled = state.enabled !== false;
    currentMode = state.mode || "manual";
    customMoods = state.customMoods || [];
    currentIntensity = state.intensity || 2;
    currentTheme = state.theme || "dark";
    currentPaused = state.paused === true;

    // Apply initial mood hue
    document.body.dataset.mood = currentMood;


    // Theme loading
    applyTheme(currentTheme);

    // Degree Slider loading
    degreeSlider.value = currentIntensity;
    updateSliderUI(currentIntensity);

    // Pause/Resume state loading
    updatePauseResumeUI();

    renderCarousel();
    updateModeUI();
    updateStatus();
    checkAiAvailability();
  });

  // Load saved commands
  chrome.runtime.sendMessage({ type: "GET_COMMANDS" }, (res) => {
    if (chrome.runtime.lastError) return;
    savedCommands = res?.commands || [];
    renderCommandList();
  });

  // ── Tabs ──────────────────────────────────────────────────────────────────
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Disabled tabs still switch content (to show under-construction), but
      // they never steal the active underline indicator from the current tab.
      if (btn.classList.contains("tab-disabled")) {
        document
          .querySelectorAll(".tab-content")
          .forEach((c) => c.classList.remove("active"));
        document
          .getElementById(`tab-${btn.dataset.tab}`)
          .classList.add("active");
        return; // leave active underline on the previously active tab-btn
      }
      document
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelectorAll(".tab-content")
        .forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });

  // ── Theme Switcher ────────────────────────────────────────────────────────
  themeToggleBtn.addEventListener("click", () => {
    const nextTheme = currentTheme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    chrome.runtime.sendMessage({ type: "SET_THEME", theme: nextTheme });
  });

  function applyTheme(theme) {
    currentTheme = theme;
    if (theme === "light") {
      document.body.classList.add("light-theme");
      themeToggleBtn.innerHTML = "&#9790;"; // Unicode Crescent Moon
    } else {
      document.body.classList.remove("light-theme");
      themeToggleBtn.innerHTML = "&#9788;"; // Unicode Sun
    }
  }

  // ── Degree Slider ─────────────────────────────────────────────────────────
  degreeSlider.addEventListener("input", () => {
    const val = parseInt(degreeSlider.value);
    updateSliderUI(val);
    chrome.runtime.sendMessage({ type: "SET_INTENSITY", intensity: val });
  });

  document.querySelectorAll(".tick-label").forEach((tick) => {
    tick.addEventListener("click", () => {
      const val = parseInt(tick.dataset.value);
      degreeSlider.value = val;
      updateSliderUI(val);
      chrome.runtime.sendMessage({ type: "SET_INTENSITY", intensity: val });
    });
  });

  function updateSliderUI(val) {
    currentIntensity = val;
    const labels = { 1: "Subtle", 2: "Moderate", 3: "Extreme" };
    intensityBadge.textContent = labels[val] || "Moderate";

    document.querySelectorAll(".tick-label").forEach((el) => {
      el.classList.toggle("active", parseInt(el.dataset.value) === val);
    });

    // Modulate globe scale based on intensity
    const scales = { 1: "0.88", 2: "1.0", 3: "1.12" };
    globeSphere.style.transform = `scale(${scales[val]})`;
  }

  // ── Mood Carousel & Globe ──────────────────────────────────────────────────
  const MOOD_GRADIENTS = {
    standard: "linear-gradient(135deg, #7a8fa6, #b0bec5)" /* steel slate */,
    cherry: "linear-gradient(135deg, #f06292, #ff8a65)" /* cherry blossom */,
    honest: "linear-gradient(135deg, #29b6f6, #80deea)" /* arctic blue */,
    "brutally-honest":
      "linear-gradient(135deg, #ef5350, #ff7043)" /* ember orange-red */,
    academic: "linear-gradient(135deg, #7c4dff, #7986cb)" /* ink indigo */,
    casual: "linear-gradient(135deg, #26a69a, #66bb6a)" /* mint jade */,
    poetic: "linear-gradient(135deg, #ce93d8, #b39ddb)" /* twilight lavender */,
  };

  const MOOD_SHADOWS = {
    standard: "rgba(122, 143, 166, 0.35)",
    cherry: "rgba(240, 98, 146, 0.5)",
    honest: "rgba(41, 182, 246, 0.45)",
    "brutally-honest": "rgba(239, 83, 80, 0.55)",
    academic: "rgba(124, 77, 255, 0.45)",
    casual: "rgba(38, 166, 154, 0.45)",
    poetic: "rgba(206, 147, 216, 0.5)",
  };

  function updateGlobe(moodData, isCustom) {
    globeLabel.textContent = moodData.name;
    globeDesc.textContent = moodData.desc || "";

    let gradient = MOOD_GRADIENTS[moodData.id];
    let shadow = MOOD_SHADOWS[moodData.id];

    if (isCustom && moodData.gradient) {
      gradient = moodData.gradient;
      shadow = "rgba(124, 106, 239, 0.45)";
    }

    globeSphere.style.setProperty(
      "--custom-gradient",
      gradient || MOOD_GRADIENTS.standard,
    );
    globeSphere.style.setProperty(
      "--globe-shadow",
      shadow || MOOD_SHADOWS.standard,
    );

    if (globeHue) {
      globeHue.style.setProperty(
        "--custom-gradient",
        gradient || MOOD_GRADIENTS.standard,
      );
    }

    // Quick bounce animation on globe change
    const inner = document.querySelector(".globe-ring");
    if (inner) {
      inner.style.transform = "scale(0.9)";
      setTimeout(() => {
        inner.style.transform = "";
      }, 150);
    }
  }

  // Swatch colors matching the per-mood hue palette
  const MOOD_SWATCHES = {
    standard: "#8fa3b8",
    cherry: "#f06292",
    honest: "#29b6f6",
    "brutally-honest": "#ef5350",
    academic: "#7c4dff",
    casual: "#26a69a",
    poetic: "#ce93d8",
  };

  function getMoodSwatch(mood, isCustom) {
    if (isCustom && mood.gradient) {
      // Extract first color from gradient string
      const match = mood.gradient.match(/#[0-9a-fA-F]{6}/);
      return match ? match[0] : "#888";
    }
    return MOOD_SWATCHES[mood.id] || "#888";
  }

  function renderCarousel() {
    carouselTrack.innerHTML = "";

    // Built-in
    for (const m of BUILTIN_MOODS) {
      carouselTrack.appendChild(createCarouselItem(m, false));
    }

    // Custom
    for (const m of customMoods) {
      carouselTrack.appendChild(createCarouselItem(m, true));
    }

    // Add pill
    const addCard = document.createElement("div");
    addCard.className = "carousel-item carousel-add-item";
    addCard.innerHTML = `
      <span class="item-swatch">+</span>
      <span class="item-label">Custom</span>
    `;
    addCard.addEventListener("click", openModal);
    carouselTrack.appendChild(addCard);

    syncCarouselSelection();
    initCarouselScroll();
  }

  function createCarouselItem(mood, isCustom) {
    const item = document.createElement("div");
    item.className =
      "carousel-item" + (mood.id === currentMood ? " selected" : "");
    item.dataset.mood = mood.id;

    const swatchColor = getMoodSwatch(mood, isCustom);
    item.innerHTML = `
      <span class="item-swatch" style="background:${swatchColor};"></span>
      <span class="item-label">${mood.name}</span>
    `;

    if (isCustom) {
      const del = document.createElement("button");
      del.className = "mood-delete";
      del.textContent = "✕";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteCustomMood(mood.id);
      });
      item.appendChild(del);
    }

    item.addEventListener("click", () => selectMood(mood, isCustom));
    return item;
  }

  function syncCarouselSelection() {
    document.querySelectorAll(".carousel-item").forEach((el) => {
      el.classList.toggle("selected", el.dataset.mood === currentMood);
    });

    const activeMood =
      BUILTIN_MOODS.find((m) => m.id === currentMood) ||
      customMoods.find((m) => m.id === currentMood);
    if (activeMood) {
      const isCustom = customMoods.some((m) => m.id === currentMood);
      updateGlobe(activeMood, isCustom);
    }

    scrollToActiveItem();
  }

  // Carousel is a static CSS grid — no scroll logic needed.
  function scrollToActiveItem() {}
  function initCarouselScroll() {}

  function selectMood(mood, isCustom) {
    if (mood.id === currentMood) return;
    currentMood = mood.id;

    // Set body data-mood so CSS per-mood hues activate
    document.body.dataset.mood = mood.id;

    // Trigger full-body hue pulse (both ::before and ::after)
    document.body.classList.remove("hue-pulse");
    void document.body.offsetWidth; // force reflow
    document.body.classList.add("hue-pulse");

    // Re-trigger globe pulse
    globeSphere.classList.remove("mood-changed");
    void globeSphere.offsetWidth;
    globeSphere.classList.add("mood-changed");

    syncCarouselSelection();
    updateStatus();

    const msg = { type: "SET_MOOD", mood: mood.id };
    if (isCustom && mood.prompt) {
      msg.customPrompt = mood.prompt;
    }
    chrome.runtime.sendMessage(msg);
  }

  // ── Custom Mood Modal ─────────────────────────────────────────────────────
  function openModal() {
    customName.value = "";
    customDesc.value = "";
    moodModal.classList.add("show");
    setTimeout(() => customName.focus(), 100);
  }

  modalCancel.addEventListener("click", () => {
    moodModal.classList.remove("show");
  });

  moodModal.addEventListener("click", (e) => {
    if (e.target === moodModal) moodModal.classList.remove("show");
  });

  modalSave.addEventListener("click", () => {
    const name = customName.value.trim();
    const desc = customDesc.value.trim();

    if (!name) {
      customName.focus();
      return;
    }
    if (!desc) {
      customDesc.focus();
      return;
    }

    // Auto-generate AI system prompt from name + description
    const prompt = `You rephrase text in a ${name} style. ${desc}. Output ONLY the rephrased text, nothing else.`;

    const id =
      "custom-" +
      name.toLowerCase().replace(/[^a-z0-9]/g, "-") +
      "-" +
      Date.now();
    const gradient =
      CUSTOM_GRADIENTS[customMoods.length % CUSTOM_GRADIENTS.length];

    const newMood = { id, name, desc, prompt, gradient };

    chrome.runtime.sendMessage(
      { type: "SAVE_CUSTOM_MOOD", mood: newMood },
      () => {
        customMoods.push(newMood);
        renderCarousel();
        moodModal.classList.remove("show");
      },
    );
  });

  function deleteCustomMood(id) {
    chrome.runtime.sendMessage({ type: "DELETE_CUSTOM_MOOD", id }, () => {
      customMoods = customMoods.filter((m) => m.id !== id);
      if (currentMood === id) {
        currentMood = "standard";
        chrome.runtime.sendMessage({ type: "SET_MOOD", mood: "standard" });
        updateStatus();
      }
      renderCarousel();
    });
  }

  // ── Pause / Resume Toggle + Restart ──────────────────────────────────────

  /**
   * Syncs the pause button label & style to current state.
   * pauseBtn is disabled until Run has been clicked at least once.
   */
  function updatePauseResumeUI() {
    if (currentMode === "auto") {
      pauseBtn.disabled = false;
    } else {
      pauseBtn.disabled = !(runStarted || currentPaused);
    }

    if (currentPaused) {
      pauseBtn.classList.add("paused-state");
      pauseBtn.title = "Resume";
    } else {
      pauseBtn.classList.remove("paused-state");
      pauseBtn.title = "Pause";
    }
  }

  pauseBtn.addEventListener("click", () => {
    if (!runStarted) return;
    currentPaused = !currentPaused;
    updatePauseResumeUI();
    chrome.runtime.sendMessage({ type: "SET_PAUSED", paused: currentPaused });
  });

  restartBtn.addEventListener("click", () => {
    restartBtn.style.transform = "scale(0.92)";
    setTimeout(() => {
      restartBtn.style.transform = "";
    }, 150);
    // Restart resets pause state
    currentPaused = false;
    runStarted = false;
    updatePauseResumeUI();
    chrome.runtime.sendMessage({ type: "SET_PAUSED", paused: false });
    chrome.runtime.sendMessage({ type: "RESTART_REPHRASE" });
  });

  // ── Mode Toggle ───────────────────────────────────────────────────────────
  document.querySelectorAll(".mode-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      const newMode = btn.dataset.mode;
      if (newMode === currentMode) return;
      currentMode = newMode;
      updateModeUI();
      chrome.runtime.sendMessage({ type: "SET_MODE", mode: newMode });
    });
  });

  function updateModeUI() {
    document.querySelectorAll(".mode-opt").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === currentMode);
    });
  }

  // Manual trigger — also activates the Pause button for the first time
  triggerBtn.addEventListener("click", () => {
    triggerBtn.style.transform = "scale(0.92)";
    setTimeout(() => {
      triggerBtn.style.transform = "";
    }, 150);
    // Mark run as started so Pause becomes usable
    runStarted = true;
    currentPaused = false;
    updatePauseResumeUI();
    chrome.runtime.sendMessage({ type: "TRIGGER_REWRITE" });
  });

  // ── Commands ──────────────────────────────────────────────────────────────
  function renderCommandList() {
    cmdList.innerHTML = "";

    if (savedCommands.length === 0) {
      cmdList.innerHTML = `
        <div class="cmd-empty">
          <div>No saved commands yet.</div>
          <div style="font-size:9px;color:var(--text-dim);margin-top:4px;">Type a command above and save it!</div>
        </div>
      `;
      cmdBulkRow.style.display = "none";
      return;
    }

    cmdBulkRow.style.display = "flex";

    for (const cmd of savedCommands) {
      const item = document.createElement("div");
      item.className = "cmd-item";
      item.dataset.id = cmd.id;

      item.innerHTML = `
        <div class="cmd-check ${cmd.active ? "checked" : ""}" data-id="${cmd.id}">✓</div>
        <div class="cmd-text" title="${escapeHtml(cmd.text)}">${escapeHtml(cmd.text)}</div>
        <div class="cmd-actions">
          <button class="cmd-action-btn cmd-play-btn" data-id="${cmd.id}" title="Run">→</button>
          <button class="cmd-action-btn cmd-del-btn" data-id="${cmd.id}" title="Delete">✕</button>
        </div>
      `;

      cmdList.appendChild(item);
    }

    // Event delegation
    cmdList.querySelectorAll(".cmd-check").forEach((el) => {
      el.addEventListener("click", () => toggleCommand(el.dataset.id));
    });
    cmdList.querySelectorAll(".cmd-play-btn").forEach((el) => {
      el.addEventListener("click", () => runSingleCommand(el.dataset.id));
    });
    cmdList.querySelectorAll(".cmd-del-btn").forEach((el) => {
      el.addEventListener("click", () => deleteCommand(el.dataset.id));
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Run from input
  cmdRunBtn.addEventListener("click", () => runFromInput());
  cmdInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runFromInput();
  });

  function runFromInput() {
    const text = cmdInput.value.trim();
    if (!text) return;

    // Run it
    chrome.runtime.sendMessage({ type: "RUN_COMMAND", commandText: text });

    // Auto-save if not already saved
    const exists = savedCommands.some(
      (c) => c.text.toLowerCase() === text.toLowerCase(),
    );
    if (!exists) {
      const cmd = { id: "cmd-" + Date.now(), text, active: true };
      chrome.runtime.sendMessage({ type: "SAVE_COMMAND", command: cmd }, () => {
        savedCommands.push(cmd);
        renderCommandList();
      });
    }

    cmdInput.value = "";

    // Visual feedback
    cmdRunBtn.style.transform = "scale(0.9)";
    setTimeout(() => {
      cmdRunBtn.style.transform = "";
    }, 150);
  }

  function toggleCommand(id) {
    const cmd = savedCommands.find((c) => c.id === id);
    if (!cmd) return;
    cmd.active = !cmd.active;
    chrome.runtime.sendMessage({ type: "SAVE_COMMAND", command: cmd });
    renderCommandList();
  }

  function runSingleCommand(id) {
    const cmd = savedCommands.find((c) => c.id === id);
    if (!cmd) return;
    chrome.runtime.sendMessage({ type: "RUN_COMMAND", commandText: cmd.text });
  }

  function deleteCommand(id) {
    chrome.runtime.sendMessage({ type: "DELETE_COMMAND", id }, () => {
      savedCommands = savedCommands.filter((c) => c.id !== id);
      renderCommandList();
    });
  }

  // Bulk buttons
  cmdRunSelected.addEventListener("click", () => {
    const selected = savedCommands.filter((c) => c.active).map((c) => c.text);
    if (selected.length === 0) return;
    chrome.runtime.sendMessage({ type: "RUN_COMMANDS", commands: selected });
  });

  cmdRunAll.addEventListener("click", () => {
    const all = savedCommands.map((c) => c.text);
    if (all.length === 0) return;
    chrome.runtime.sendMessage({ type: "RUN_COMMANDS", commands: all });
  });

  // ── Status ────────────────────────────────────────────────────────────────
  function updateStatus() {
    if (!currentEnabled) {
      dot.className = "status-dot";
      statusTx.textContent = "MoodLens paused";
      return;
    }
    dot.className = "status-dot active";
    const moodData =
      BUILTIN_MOODS.find((m) => m.id === currentMood) ||
      customMoods.find((m) => m.id === currentMood);
    const moodName = moodData ? moodData.name : currentMood;
    const modeLabel = currentMode === "auto" ? "Auto" : "Manual";
    statusTx.textContent = `Active · ${moodName} · ${modeLabel}`;
  }

  // ── Progress ──────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "PROGRESS_UPDATE") {
      if (msg.active) {
        runStarted = true;
      } else if (!currentPaused) {
        runStarted = false;
      }
      updatePauseResumeUI();

      if (msg.active && msg.pending > 0 && currentEnabled) {
        progressBar.classList.add("show");
        if (msg.paused) {
          progressText.textContent = `Paused (${msg.pending} items left)`;
        } else {
          progressText.textContent = `Processing ${msg.pending} items...`;
        }
      } else {
        progressBar.classList.remove("show");
      }
    }
  });

  // ── AI probe ──────────────────────────────────────────────────────────────
  async function checkAiAvailability() {
    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (err) {
      aiDetail.textContent = "Could not query active tab.";
      return;
    }

    if (!tab?.id) {
      aiDetail.textContent = "No active tab found.";
      return;
    }

    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
          const lmGlobal =
            window.LanguageModel ??
            self.LanguageModel ??
            globalThis.LanguageModel;
          const ai = window.ai ?? self.ai ?? globalThis.ai ?? null;
          return {
            hasLanguageModelGlobal: !!lmGlobal,
            hasLanguageModel: !!ai?.languageModel,
            hasAssistant: !!ai?.assistant,
            windowAi: typeof window.ai,
          };
        },
      });
    } catch (err) {
      dot.className = "status-dot";
      statusTx.textContent = "Cannot probe this tab";
      return;
    }

    const report = results?.[0]?.result;

    if (!report) {
      aiBanner.classList.add("show");
      aiDetail.textContent = "Probe blocked by page";
      dot.className = "status-dot error";
      statusTx.textContent = "Probe blocked";
      return;
    }

    const aiPresent =
      report.hasLanguageModelGlobal ||
      report.hasLanguageModel ||
      report.hasAssistant;

    let detailStr = `LanguageModel: ${report.hasLanguageModelGlobal}`;
    if (!report.hasLanguageModelGlobal)
      detailStr += ` | ai: ${report.windowAi}`;
    aiDetail.textContent = detailStr;

    if (!aiPresent) {
      aiBanner.classList.add("show");
      dot.className = "status-dot error";
      statusTx.textContent = "LanguageModel missing";
    } else {
      aiBanner.classList.remove("show");
      updateStatus();
    }
  }
})();