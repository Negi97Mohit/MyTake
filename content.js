// content.js — MyTake v2.0 ISOLATED world content script
// Handles: mood rephrasing (manual), AI commands, DOM scanning,
// MutationObserver, local caching, and streaming text updates.

(() => {
  const TAG = "[MyTake]";
  const CHANNEL = "MYTAKE_BRIDGE";

  // ── Config ──────────────────────────────────────────────────────────────────
  const MIN_CHARS = 5;
  const MAX_CHARS = 800;
  const BATCH_DELAY_MS = 100;
  const MAX_BATCH_SIZE = 20;

  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "CODE",
    "PRE",
    "KBD",
    "VAR",
    "SAMP",
    "MATH",
    "SVG",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "BUTTON",
    "OPTION",
    "HEAD",
    "TITLE",
  ]);

  // ── State ───────────────────────────────────────────────────────────────────
  let mood = "original";
  let customPrompt = null;
  let enabled = true;
  let mode = "manual"; // 'manual' | 'target'
  let aiReady = false;
  let aiError = null;
  let pendingNodes = new Set();
  let batchTimer = null;
  let processedNodes = new WeakSet();
  let requestCounter = 0;
  let intensity = 2;
  let popupOpen = false;
  let manualRunning = false;
  let paused = false;

  // Track nodes currently being processed by AI (inflight)
  let inflightNodes = new WeakSet();

  // Per-request completion callbacks (used by target mode)
  const inflightRequestCallbacks = new Map();

  // ── Viewport Observer for Lazy Translation ────────────────────────────────
  const viewportObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const parent = entry.target;
          if (parent._mytakeTextNodes) {
            for (const n of parent._mytakeTextNodes) {
              if (n.isConnected && n.textContent.trim()) {
                pendingNodes.add(n);
              }
            }
            // Auto mode removed
            parent._mytakeTextNodes.clear();
          }
          viewportObserver.unobserve(parent);
        }
      }
    },
    { rootMargin: "400px" },
  );

  // Map of requestId → DOM text node
  const inflightRequests = new Map();

  // ── Command tracking ────────────────────────────────────────────────────────
  const commandInflightRequests = new Map(); // requestId → { node, originalText }
  let commandQueue = []; // Array of { commandText, nodes[] }
  let commandRunning = false;

  // ── Cache management ────────────────────────────────────────────────────────
  let cacheMap = {};

  function loadCache() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(["mytake_cache"], (res) => {
          if (res && res.mytake_cache) {
            cacheMap = res.mytake_cache;
            console.log(
              `${TAG} Loaded ${Object.keys(cacheMap).length} cached translations.`,
            );
          }
          resolve();
        });
      } catch (err) {
        console.warn(`${TAG} Failed to load cache:`, err);
        resolve();
      }
    });
  }

  let saveCacheTimer = null;

  function saveToCache(originalText, rephrasedText, specificMood) {
    if (!originalText || !rephrasedText) return;
    const trimOrig = originalText.trim();
    const trimReph = rephrasedText.trim();
    if (trimOrig === trimReph || trimOrig.length < MIN_CHARS) return;

    // Use the specific target mood if provided, otherwise fallback to global mood
    const activeMood = specificMood || mood;
    const key = `${activeMood}_${trimOrig}`;
    cacheMap[key] = trimReph;

    const keys = Object.keys(cacheMap);
    if (keys.length > 2000) {
      for (let i = 0; i < 200; i++) delete cacheMap[keys[i]];
    }

    if (saveCacheTimer) clearTimeout(saveCacheTimer);
    saveCacheTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ mytake_cache: cacheMap });
      } catch (err) {}
    }, 3000);
  }

  function getFromCache(originalText, specificMood) {
    if (!originalText) return null;
    const activeMood = specificMood || mood;
    return cacheMap[`${activeMood}_${originalText.trim()}`] || null;
  }

  // ── PostMessage bridge to MAIN world ────────────────────────────────────────
  function postToMain(type, data = {}) {
    window.postMessage(
      { channel: CHANNEL, direction: "TO_MAIN", type, ...data },
      "*",
    );
  }

  // Listen for responses from content-main.js
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.direction !== "TO_ISOLATED")
      return;

    if (msg.type === "REQUEST_MODEL_UPDATE") {
      try {
        chrome.runtime
          .sendMessage({ type: "TRIGGER_MODEL_UPDATE" })
          .catch(() => {});
      } catch (_) {}
      return;
    }

    if (msg.type === "BRIDGE_READY" || msg.type === "PONG") {
      console.log(`${TAG} MAIN bridge responded — AI present: ${msg.hasAI}`);
      if (msg.hasAI && enabled) {
        initSession();
      } else if (!msg.hasAI) {
        aiReady = false;
        aiError = "no_api";
        console.warn(`${TAG} No AI API available.`);
      }
    }

    if (msg.type === "AI_STATUS") {
      aiError = msg.error || null;
      if (msg.available) {
        aiReady = true;
        console.log(`${TAG} ✅ AI session ready for mood: "${msg.mood}"`);
        if (mood !== "original") {
          scheduleScan(document.body);
        }
        startObserver();
      } else {
        aiReady = false;
        console.error(`${TAG} ❌ AI unavailable: ${msg.error}`);
      }
      try {
        chrome.runtime.sendMessage({
          type: "AI_STATUS_UPDATE",
          available: msg.available,
          error: msg.error,
          mood: msg.mood
        }).catch(() => {});
      } catch (_) {}
    }

    if (msg.type === "DOWNLOAD_PROGRESS") {
      try {
        chrome.runtime.sendMessage({
          type: "DOWNLOAD_PROGRESS",
          loaded: msg.loaded,
          total: msg.total
        }).catch(() => {});
      } catch (_) {}
    }

    // ── Mood rephrase streaming ─────────────────────────────────────────────
    if (msg.type === "REPHRASE_STREAM") {
      const node = inflightRequests.get(msg.requestId);
      if (node && node.isConnected) {
        node._mytakeRephrased = msg.text;
        node.textContent = msg.text;
      }
    }

    if (msg.type === "REPHRASE_DONE") {
      const node = inflightRequests.get(msg.requestId);
      inflightRequests.delete(msg.requestId);

      if (node && node.isConnected) {
        node._mytakeRephrased = msg.text;
        node.textContent = msg.text;
        processedNodes.add(node);
        inflightNodes.delete(node);

        // NEW: Tell the cache exactly which mood generated this text
        const appliedMood = node._mytakeTargetMood || mood;
        saveToCache(node._mytakeOriginal, msg.text, appliedMood);
      } else if (node) {
        inflightNodes.delete(node);
      }

      const cb = inflightRequestCallbacks.get(msg.requestId);
      if (cb) {
        inflightRequestCallbacks.delete(msg.requestId);
        cb(null);
      }

      broadcastProgress();
      if (pendingNodes.size > 0 && manualRunning)
        scheduleBatch();
    }
    if (msg.type === "REPHRASE_FAIL") {
      const node = inflightRequests.get(msg.requestId);
      inflightRequests.delete(msg.requestId);

      if (node) {
        inflightNodes.delete(node);
        if (node.isConnected && node._mytakeOriginal) {
          node._mytakeRephrased = node._mytakeOriginal;
          node.textContent = node._mytakeOriginal;
          node._mytakeRephrased = undefined;
        }
      }

      // Target mode explicit error pass
      const cb = inflightRequestCallbacks.get(msg.requestId);
      if (cb) {
        inflightRequestCallbacks.delete(msg.requestId);
        cb(msg.error || "Model crashed");
      }

      broadcastProgress();
      if (pendingNodes.size > 0 && manualRunning)
        scheduleBatch();
    }

    // ── Command streaming ───────────────────────────────────────────────────
    if (msg.type === "COMMAND_STREAM") {
      const entry = commandInflightRequests.get(msg.requestId);
      if (entry && entry.node && entry.node.isConnected) {
        entry.node._mytakeRephrased = msg.text;
        entry.node.textContent = msg.text;
      }
    }

    if (msg.type === "COMMAND_DONE") {
      const entry = commandInflightRequests.get(msg.requestId);
      commandInflightRequests.delete(msg.requestId);

      if (entry && entry.node && entry.node.isConnected) {
        entry.node._mytakeRephrased = msg.text;
        entry.node.textContent = msg.text;
        processedNodes.add(entry.node);
        inflightNodes.delete(entry.node);
      }

      broadcastProgress();
      processNextCommandBatch();
    }

    if (msg.type === "COMMAND_FAIL") {
      const entry = commandInflightRequests.get(msg.requestId);
      commandInflightRequests.delete(msg.requestId);

      if (entry && entry.node) {
        inflightNodes.delete(entry.node);
        if (entry.node.isConnected && entry.originalText) {
          entry.node._mytakeRephrased = entry.originalText;
          entry.node.textContent = entry.originalText;
          entry.node._mytakeRephrased = undefined;
        }
      }

      broadcastProgress();
      processNextCommandBatch();
    }
  });

  // ── Session management ──────────────────────────────────────────────────────
  function initSession() {
    if (mood === "original") {
      console.log(`${TAG} Original mood. Bypassing AI session.`);
      aiReady = true;
      scheduleScan(document.body);
      startObserver();
      return;
    }
    console.log(
      `${TAG} Requesting AI session for mood: "${mood}" (intensity: ${intensity})`,
    );
    postToMain("INIT_SESSION", {
      mood,
      customPrompt: customPrompt || undefined,
      intensity,
    });
  }

  function destroySession() {
    postToMain("DESTROY_SESSION");
    aiReady = false;
  }

  // ── Broadcast progress to popup ─────────────────────────────────────────────
  function broadcastProgress(opts) {
    if (!popupOpen) return;
    try {
      const active =
        manualRunning ||
        inflightRequests.size > 0 ||
        commandInflightRequests.size > 0;
      chrome.runtime
        .sendMessage({
          type: "PROGRESS_UPDATE",
          pending:
            pendingNodes.size +
            inflightRequests.size +
            commandInflightRequests.size,
          active: active,
          paused: paused,
          targetMode: opts?.targetMode || false,
        })
        .catch(() => {});
    } catch (_) {}
  }

  // ── Queue / batch ──────────────────────────────────────────────────────────
  function queueNode(node) {
    if (!enabled) return;

    const currentText = node.textContent.trim();
    if (!currentText) return;

    if (mood === "original") {
      if (
        node._mytakeOriginal !== undefined &&
        currentText !== node._mytakeOriginal
      ) {
        node.textContent = node._mytakeOriginal;
        node._mytakeRephrased = undefined;
      }
      return;
    }

    if (!aiReady) return;
    if (processedNodes.has(node)) return;
    if (inflightNodes.has(node)) return;

    if (node._mytakeTargetMood === mood) return;

    if (
      node._mytakeRephrased !== undefined &&
      currentText === node._mytakeRephrased
    )
      return;

    if (
      node._mytakeRephrased !== undefined &&
      currentText !== node._mytakeRephrased
    ) {
      node._mytakeOriginal = currentText;
      node._mytakeRephrased = undefined;
    } else if (node._mytakeOriginal === undefined) {
      node._mytakeOriginal = currentText;
    }

    const original = node._mytakeOriginal;
    if (original.length < MIN_CHARS || original.length > MAX_CHARS) return;

    const cached = getFromCache(original);
    if (cached) {
      node._mytakeRephrased = cached;
      node.textContent = cached;
      processedNodes.add(node);
      return;
    }

    pendingNodes.add(node);
    // Only auto-process if user has already clicked Run
    if (manualRunning) {
      scheduleBatch();
    }
  }

  function scheduleBatch() {
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(processBatch, BATCH_DELAY_MS);
    broadcastProgress();
  }

  async function processBatch() {
    if (!enabled || !aiReady || mood === "original") {
      if (mood === "original" && pendingNodes.size > 0) pendingNodes.clear();
      manualRunning = false;
      broadcastProgress();
      return;
    }

    if (paused) {
      broadcastProgress();
      return;
    }

    const batch = [...pendingNodes].slice(0, MAX_BATCH_SIZE);
    for (const n of batch) pendingNodes.delete(n);
    broadcastProgress();

    if (batch.length === 0) {
      manualRunning = false;
      return;
    }

    for (const node of batch) {
      if (!node.isConnected) continue;
      if (processedNodes.has(node) || inflightNodes.has(node)) continue;

      const original = node._mytakeOriginal;
      if (!original || original.length < MIN_CHARS) continue;

      const requestId = `req_${++requestCounter}`;
      inflightRequests.set(requestId, node);
      inflightNodes.add(node);
      postToMain("REPHRASE_REQUEST", { requestId, text: original });
    }

    if (pendingNodes.size > 0 && manualRunning) {
      scheduleBatch();
    } else if (pendingNodes.size === 0) {
      manualRunning = false;
    }
  }

  // ── Manual trigger: flush all pending ──────────────────────────────────────
  function triggerManualRewrite() {
    if (!enabled || paused || !aiReady || mood === "original") return;
    console.log(
      `${TAG} Manual trigger — flushing ${pendingNodes.size} pending nodes`,
    );
    manualRunning = true;
    processBatch();
  }

  // ── Restart Translation from Scratch ────────────────────────────────────────
  function restartRephrasing() {
    console.log(`${TAG} Restarting rephrasing on page...`);

    // NEW: Tell the AI bridge to immediately dump all pending background tasks
    postToMain("DESTROY_SESSION");

    pendingNodes.clear();
    inflightRequests.clear();
    commandInflightRequests.clear();
    inflightNodes = new WeakSet();
    commandQueue = [];
    commandRunning = false;
    manualRunning = false;
    if (batchTimer) clearTimeout(batchTimer);

    restoreOriginals();
    processedNodes = new WeakSet();

    scheduleScan(document.body);
    if (!paused) {
      scheduleBatch();
    }
    broadcastProgress();
  }

  // ── Smart Targeted Command Heuristic Engine ────────────────────────────────
  function getTargetedNodesForCommand(commandText, allNodes) {
    const cmd = commandText.toLowerCase();
    let filtered = [];

    if (
      /\b(price|money|cost|dollar|eur|usd|inr|rupee|currency|conversion|convert|prizes|exchange)\b/.test(
        cmd,
      )
    ) {
      filtered = allNodes.filter((n) =>
        /[$€£₹¥]|(\d+(\.\d+)?)\s*(usd|eur|gbp|inr|dollars|euros|rupees)?/i.test(
          n.textContent,
        ),
      );
      return filtered;
    }

    if (
      /\b(number|digit|math|unit|convert|measurement|miles|km|kg|lbs|celsius|fahrenheit)\b/.test(
        cmd,
      )
    ) {
      filtered = allNodes.filter((n) => /\d/.test(n.textContent));
      return filtered;
    }

    if (/\b(email|phone|link|url|contact)\b/.test(cmd)) {
      filtered = allNodes.filter((n) =>
        /@|\+?\d{7,15}|https?:\/\//i.test(n.textContent),
      );
      return filtered;
    }

    if (
      /\b(name|people|place|city|country|location|proper noun|person)\b/.test(
        cmd,
      )
    ) {
      filtered = allNodes.filter((n) =>
        /[A-Z][a-z]+/.test(n.textContent.trim()),
      );
      return filtered;
    }

    if (/\b(summarize|shorten|simplify|explain|rewrite|rephrase)\b/.test(cmd)) {
      filtered = allNodes.filter((n) => n.textContent.trim().length > 30);
      return filtered;
    }

    filtered = allNodes.filter((n) => n.textContent.trim().length > 25);
    return filtered;
  }

  // ── AI Command Execution ───────────────────────────────────────────────────
  function runCommand(commandText) {
    if (!enabled) return;
    console.log(`${TAG} Running command: "${commandText}"`);

    const rawNodes = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(n) {
          if (!n.parentElement) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(n.parentElement.tagName.toUpperCase()))
            return NodeFilter.FILTER_REJECT;
          if (isExcludedAncestry(n)) return NodeFilter.FILTER_REJECT;
          const text = n.textContent.trim();
          if (text.length < MIN_CHARS || text.length > MAX_CHARS)
            return NodeFilter.FILTER_REJECT;
          if (!isVisible(n)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    let n;
    while ((n = walker.nextNode())) {
      rawNodes.push(n);
    }

    const nodes = getTargetedNodesForCommand(commandText, rawNodes);
    if (nodes.length === 0) return;

    for (const node of nodes) {
      if (node._mytakeOriginal === undefined) {
        node._mytakeOriginal = node.textContent.trim();
      }
    }

    commandQueue.push({ commandText, nodes });
    if (!commandRunning) processNextCommandBatch();
  }

  function runMultipleCommands(commands) {
    for (const cmd of commands) runCommand(cmd);
  }

  function processNextCommandBatch() {
    if (commandInflightRequests.size > 0) return;

    if (commandQueue.length === 0) {
      commandRunning = false;
      return;
    }

    commandRunning = true;
    const { commandText, nodes } = commandQueue[0];

    const batch = nodes.splice(0, MAX_BATCH_SIZE);
    if (nodes.length === 0) commandQueue.shift();

    for (const node of batch) {
      if (!node.isConnected) continue;
      if (inflightNodes.has(node)) continue;

      const original = node._mytakeOriginal || node.textContent.trim();
      if (!original || original.length < MIN_CHARS) continue;

      const requestId = `cmd_${++requestCounter}`;
      commandInflightRequests.set(requestId, { node, originalText: original });
      inflightNodes.add(node);
      postToMain("COMMAND_REQUEST", { requestId, text: original, commandText });
    }

    broadcastProgress();
  }

  // ── Non-Blocking DOM Scanner ───────────────────────────────────────────────
  let scanTimer = null;
  const nodesToScan = new Set();

  function isExcludedAncestry(node) {
    let parent = node.parentElement;
    while (parent) {
      if (SKIP_TAGS.has(parent.tagName.toUpperCase())) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function scheduleScan(node) {
    if (!node) return;
    nodesToScan.add(node);
    if (scanTimer) return;
    scanTimer = setTimeout(processPendingScans, 100);
  }

  function processPendingScans() {
    scanTimer = null;
    const targets = [...nodesToScan];
    nodesToScan.clear();
    if (targets.length === 0) return;
    processScanChunks(targets);
  }

  function processScanChunks(targets) {
    if (targets.length === 0) return;

    const chunk = targets.slice(0, 4);
    const remaining = targets.slice(4);

    for (const target of chunk) {
      if (!target.isConnected) continue;

      if (target.nodeType === Node.TEXT_NODE) {
        queueNode(target);
      } else if (target.nodeType === Node.ELEMENT_NODE) {
        if (SKIP_TAGS.has(target.tagName.toUpperCase())) continue;
        if (isExcludedAncestry(target)) continue;

        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
          acceptNode(n) {
            if (!n.parentElement) return NodeFilter.FILTER_REJECT;
            if (SKIP_TAGS.has(n.parentElement.tagName.toUpperCase()))
              return NodeFilter.FILTER_REJECT;
            if (isExcludedAncestry(n)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        });

        let n;
        while ((n = walker.nextNode())) queueNode(n);
      }
    }

    if (remaining.length > 0) {
      if (window.requestIdleCallback) {
        window.requestIdleCallback(() => processScanChunks(remaining));
      } else {
        setTimeout(() => processScanChunks(remaining), 16);
      }
    }
  }

  // ── MutationObserver ────────────────────────────────────────────────────────
  let observerStarted = false;
  let mutationTimer = null;
  const queuedMutations = new Set();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const target = mutation.target;
        if (processedNodes.has(target)) continue;
        if (inflightNodes.has(target)) continue;
        const newText = target.textContent.trim();
        if (
          target._mytakeRephrased !== undefined &&
          newText === target._mytakeRephrased
        )
          continue;
        queuedMutations.add(target);
      } else if (mutation.type === "childList") {
        for (const added of mutation.addedNodes) {
          if (
            added.nodeType === Node.TEXT_NODE ||
            added.nodeType === Node.ELEMENT_NODE
          ) {
            if (!isExcludedAncestry(added)) queuedMutations.add(added);
          }
        }
      }
    }

    if (!mutationTimer) {
      mutationTimer = setTimeout(() => {
        mutationTimer = null;
        for (const node of queuedMutations) scheduleScan(node);
        queuedMutations.clear();
      }, 250);
    }
  });

  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    console.log(`${TAG} MutationObserver started`);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function isVisible(node) {
    const el = node.parentElement;
    if (!el) return false;
    try {
      const s = getComputedStyle(el);
      if (
        s.display === "none" ||
        s.visibility === "hidden" ||
        s.opacity === "0"
      )
        return false;
    } catch (_) {}
    return true;
  }

  // ── Restore all text to originals ─────────────────────────────────────────
  function restoreOriginals() {
    let count = 0;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    let n;
    while ((n = walker.nextNode())) {
      if (n._mytakeOriginal) {
        n.textContent = n._mytakeOriginal;
        n._mytakeRephrased = undefined;
        count++;
      }
    }
    console.log(`${TAG} Restored ${count} nodes.`);
  }

  // ── Reset & reinit (mood change) ──────────────────────────────────────────
  function resetAndReinit(moodKey, newCustomPrompt) {
    console.log(`${TAG} Resetting mood → "${moodKey}"`);

    pendingNodes.clear();
    inflightRequests.clear();
    commandInflightRequests.clear();
    inflightNodes = new WeakSet();
    commandQueue = [];
    commandRunning = false;
    if (batchTimer) clearTimeout(batchTimer);

    restoreOriginals();
    processedNodes = new WeakSet();

    mood = moodKey;
    customPrompt = newCustomPrompt || null;

    if (mood === "original") {
      broadcastProgress();
      initSession();
      return;
    }

    let cacheHits = 0,
      totalFound = 0;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    let n;
    while ((n = walker.nextNode())) {
      if (n._mytakeOriginal) {
        totalFound++;
        const cached = getFromCache(n._mytakeOriginal);
        if (cached) {
          n._mytakeRephrased = cached;
          n.textContent = cached;
          processedNodes.add(n);
          cacheHits++;
        } else {
          queueNode(n);
        }
      }
    }

    console.log(`${TAG} Cache hits: ${cacheHits}/${totalFound}`);
    broadcastProgress();
    initSession();
  }

  // ── Target Mode state ───────────────────────────────────────────────────────
  let targetModeActive = false;
  let targetHoveredEl = null;
  let targetPicker = null;
  let pickerFrozen = false;
  let targetLockedEl = null;
  let targetRegions = {};
  let targetPagePrefix = location.href.split("?")[0];

  // THE HARD LOCK FLAG
  let isTargetProcessing = false;

  function elementFingerprint(el) {
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.body && depth < 6) {
      const tag = cur.tagName.toLowerCase();
      const idx = Array.from(cur.parentElement?.children || []).indexOf(cur);
      parts.unshift(`${tag}[${idx}]`);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(">");
  }

  function makePageKey(el) {
    return `${targetPagePrefix}::${elementFingerprint(el)}`;
  }

  function loadTargetRegions() {
    try {
      chrome.runtime.sendMessage({ type: "GET_TARGET_REGIONS" }, (res) => {
        if (chrome.runtime.lastError) return;
        const all = res?.regions || {};
        const prefix = `${targetPagePrefix}::`;
        for (const [k, v] of Object.entries(all)) {
          if (k.startsWith(prefix)) targetRegions[k] = v;
        }
        console.log(
          `${TAG} [Target] Loaded ${Object.keys(targetRegions).length} stored target regions`,
        );
      });
    } catch (_) {}
  }

  function saveTargetRegion(el, moodId, customPromptStr) {
    const key = makePageKey(el);
    targetRegions[key] = {
      mood: moodId,
      customPrompt: customPromptStr || null,
    };
    try {
      chrome.runtime
        .sendMessage({
          type: "SAVE_TARGET_REGION",
          pageKey: key,
          mood: moodId,
          customPrompt: customPromptStr || null,
        })
        .catch(() => {});
    } catch (_) {}
  }

  const PICKER_MOODS = [
    {
      id: "original",
      name: "Original",
      desc: "View original text (Off)",
      color: "#64748b",
    },
    {
      id: "explain",
      name: "Explain",
      desc: "Explain like I'm 5",
      color: "#81c784",
    },
    {
      id: "donald",
      name: "Donald",
      desc: "Sounds like Trump",
      color: "#ffb74d",
    },
    {
      id: "cherry",
      name: "Cherry",
      desc: "Warm & uplifting",
      color: "#f06292",
    },
    {
      id: "honest",
      name: "Honest",
      desc: "Direct, no fluff",
      color: "#29b6f6",
    },
    {
      id: "brutally-honest",
      name: "Brutal",
      desc: "Blunt & straight",
      color: "#ef5350",
    },
    {
      id: "academic",
      name: "Academic",
      desc: "Formal & precise",
      color: "#7c4dff",
    },
    { id: "casual", name: "Casual", desc: "Chill & relaxed", color: "#26a69a" },
    {
      id: "poetic",
      name: "Poetic",
      desc: "Evocative & rich",
      color: "#ce93d8",
    },
  ];

  let targetStyleEl = null;

  function injectTargetStyles() {
    if (targetStyleEl) return;
    targetStyleEl = document.createElement("style");
    targetStyleEl.id = "mytake-target-styles";
    targetStyleEl.textContent = `
      body.mytake-target-active, body.mytake-target-active * { cursor: crosshair !important; }
      body.mytake-target-frozen, body.mytake-target-frozen * { cursor: default !important; }
      .mytake-picker-item, .mytake-picker-close, .mytake-picker-custom { cursor: pointer !important; }
      #mytake-custom-form button { cursor: pointer !important; }
      #mytake-custom-form input { cursor: text !important; }

      .mytake-target-hover {
        outline: 2px solid #1a73e8 !important; outline-offset: 1px !important;
        background-color: rgba(26, 115, 232, 0.08) !important;
        transition: outline 60ms ease, background-color 60ms ease; position: relative;
      }
      .mytake-target-hover::before {
        content: attr(data-mytake-tag); position: absolute; top: -20px; left: 0;
        background: #1a73e8; color: #fff; font: 700 10px/18px -apple-system, sans-serif;
        padding: 0 6px; border-radius: 3px 3px 0 0; white-space: nowrap;
        z-index: 2147483645; pointer-events: none; letter-spacing: 0.04em;
      }

      .mytake-target-processing {
        outline: 2px dashed #f59e0b !important; outline-offset: 1px !important;
        background-color: rgba(245, 158, 11, 0.07) !important;
        animation: mytake-pulse 1.1s ease-in-out infinite;
        pointer-events: none !important; /* HARD LOCK CSS */
      }
      
      .mytake-target-error {
        outline: 2px solid #ef4444 !important; outline-offset: 1px !important;
        background-color: rgba(239, 68, 68, 0.08) !important;
        pointer-events: none !important; /* HARD LOCK CSS */
      }

      @keyframes mytake-pulse { 0%, 100% { outline-color: #f59e0b; } 50% { outline-color: #fcd34d; } }

      .mytake-target-locked {
        outline: 2px solid #1a73e8 !important; outline-offset: 1px !important;
        background-color: rgba(26, 115, 232, 0.06) !important;
      }

      .mytake-target-done {
        outline: 2px solid #22c55e !important; outline-offset: 1px !important;
        background-color: rgba(34, 197, 94, 0.07) !important;
        transition: outline-color 0.6s ease, background-color 0.6s ease;
        animation: mytake-done-fade 1.4s ease forwards;
      }

      @keyframes mytake-done-fade {
        0%   { outline-color: #22c55e; background-color: rgba(34,197,94,0.10); }
        60%  { outline-color: #22c55e; background-color: rgba(34,197,94,0.07); }
        100% { outline-color: transparent; background-color: transparent; }
      }

      .mytake-picker {
        position: fixed; z-index: 2147483646; min-width: 210px; max-width: 260px;
        background: #fff; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.07);
        font-family: -apple-system, sans-serif; font-size: 13px; overflow: hidden;
        animation: mytake-picker-in 120ms cubic-bezier(0.2,0.9,0.3,1); transform-origin: top left;
      }
      @keyframes mytake-picker-in { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }

      .mytake-picker-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px 8px; font-weight: 700; font-size: 11px;
        letter-spacing: 0.07em; text-transform: uppercase; color: #888; border-bottom: 1px solid #f0f0f0;
      }
      .mytake-picker-close {
        background: none; border: none; cursor: pointer; color: #aaa; font-size: 14px;
        line-height: 1; padding: 2px 4px; border-radius: 4px; transition: background 80ms, color 80ms;
      }
      .mytake-picker-close:hover { background: #f0f0f0; color: #555; }

      .mytake-picker-item {
        display: flex; align-items: center; gap: 9px; padding: 8px 12px;
        cursor: pointer; transition: background 80ms; position: relative;
      }
      .mytake-picker-item:hover { background: #f0f4ff; }
      .mytake-picker-item.already-done::after {
        content: "✓"; position: absolute; right: 12px; color: #1a73e8; font-weight: 700; font-size: 12px;
      }

      .mytake-swatch { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 1px 3px rgba(0,0,0,0.15); }
      .mytake-picker-label { font-weight: 600; color: #111; font-size: 13px; min-width: 58px; }
      .mytake-picker-desc { font-size: 11px; color: #888; flex: 1; }
      .mytake-picker-divider { height: 1px; background: #f0f0f0; margin: 2px 0; }
      .mytake-picker-custom {
        display: flex; align-items: center; gap: 8px; padding: 8px 12px 10px;
        cursor: pointer; font-size: 12px; font-weight: 600; color: #666; transition: background 80ms, color 80ms;
      }
      .mytake-picker-custom:hover { background: #f5f5f5; color: #111; }
      .mytake-picker-custom span:first-child { color: #a78bfa; font-size: 14px; }

      #mytake-processing-badge {
        position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: 7px;
        padding: 6px 12px 6px 9px; background: #1a1a1a; color: #fff; border-radius: 999px;
        font: 600 12px/1 -apple-system, sans-serif;
        box-shadow: 0 4px 16px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.08);
        white-space: nowrap; animation: mlbadge-in 150ms cubic-bezier(0.2,0.9,0.3,1); transform-origin: top right;
      }
      @keyframes mlbadge-in { from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: scale(1); } }
      .mlbadge-spinner {
        width: 12px; height: 12px; border: 2px solid rgba(255,255,255,0.25);
        border-top-color: #f59e0b; border-radius: 50%; flex-shrink: 0; animation: mlbadge-spin 0.7s linear infinite;
      }
      @keyframes mlbadge-spin { to { transform: rotate(360deg); } }
      .mlbadge-text { color: rgba(255,255,255,0.85); letter-spacing: 0.01em; }
    `;
    (document.head || document.documentElement).appendChild(targetStyleEl);
  }

  function removeTargetStyles() {
    if (targetStyleEl) {
      targetStyleEl.remove();
      targetStyleEl = null;
    }
    document.querySelectorAll("[data-mytake-tag]").forEach((el) => {
      el.removeAttribute("data-mytake-tag");
    });
  }

  function activateTargetMode() {
    if (targetModeActive) return;
    targetModeActive = true;
    pickerFrozen = false;
    isTargetProcessing = false;
    targetLockedEl = null;
    injectTargetStyles();
    document.body.classList.add("mytake-target-active");
    document.addEventListener("mouseover", onTargetMouseOver, true);
    document.addEventListener("mouseout", onTargetMouseOut, true);
    document.addEventListener("click", onTargetClick, true);
    document.addEventListener("keydown", onTargetKeyDown, true);
    console.log(`${TAG} [Target] Mode activated`);
  }

  function deactivateTargetMode() {
    if (!targetModeActive) return;
    targetModeActive = false;
    pickerFrozen = false;
    isTargetProcessing = false;
    targetLockedEl = null;
    document.body.classList.remove("mytake-target-active");
    document.body.classList.remove("mytake-target-frozen");
    document.removeEventListener("mouseover", onTargetMouseOver, true);
    document.removeEventListener("mouseout", onTargetMouseOut, true);
    document.removeEventListener("click", onTargetClick, true);
    document.removeEventListener("keydown", onTargetKeyDown, true);
    clearTargetHover();
    clearTargetLocked();
    dismissPicker();
    removeProcessingBadge();
    removeTargetStyles();
    console.log(`${TAG} [Target] Mode deactivated`);
    try {
      chrome.runtime
        .sendMessage({ type: "TARGET_MODE_EXITED" })
        .catch(() => {});
    } catch (_) {}
  }

  function unfreezeTargetMode() {
    pickerFrozen = false;
    targetLockedEl = null;
    document.body.classList.remove("mytake-target-frozen");
    clearTargetLocked();
  }

  function clearTargetLocked() {
    document.querySelectorAll(".mytake-target-locked").forEach((el) => {
      el.classList.remove("mytake-target-locked");
    });
  }

  function clearTargetHover() {
    if (targetHoveredEl) {
      targetHoveredEl.classList.remove("mytake-target-hover");
      targetHoveredEl.removeAttribute("data-mytake-tag");
      targetHoveredEl = null;
    }
  }

  function onTargetKeyDown(e) {
    if (e.key === "Escape") {
      // HARD LOCK CHECK
      if (isTargetProcessing) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (pickerFrozen) {
        const form = document.getElementById("mytake-custom-form");
        if (form) form.remove();
        dismissPicker();
        return;
      }
      deactivateTargetMode();
      try {
        chrome.runtime
          .sendMessage({ type: "SET_MODE", mode: "manual" })
          .catch(() => {});
      } catch (_) {}
    }
  }

  function isPickerEl(el) {
    if (targetPicker && targetPicker.contains(el)) return true;
    const form = document.getElementById("mytake-custom-form");
    if (form && form.contains(el)) return true;
    return false;
  }

  function onTargetMouseOver(e) {
    if (pickerFrozen || isTargetProcessing) return;
    if (isPickerEl(e.target)) return;
    const el = getBestTargetElement(e.target);
    if (!el || el === targetHoveredEl) return;
    clearTargetHover();
    targetHoveredEl = el;
    el.classList.add("mytake-target-hover");
    el.setAttribute("data-mytake-tag", el.tagName.toLowerCase());
  }

  function onTargetMouseOut(e) {
    if (pickerFrozen || isTargetProcessing) return;
    if (isPickerEl(e.relatedTarget)) return;
    clearTargetHover();
  }

  function onTargetClick(e) {
    // HARD LOCK CHECK
    if (isTargetProcessing) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (isPickerEl(e.target)) return;
    if (pickerFrozen) return;

    e.preventDefault();
    e.stopPropagation();
    const el = getBestTargetElement(e.target) || e.target;
    clearTargetHover();

    pickerFrozen = true;
    targetLockedEl = el;
    el.classList.add("mytake-target-locked");
    document.body.classList.add("mytake-target-frozen");

    showPicker(el, e.clientX, e.clientY);
  }

  function getBestTargetElement(el) {
    const BLOCK_TAGS = new Set([
      "P",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "LI",
      "TD",
      "TH",
      "BLOCKQUOTE",
      "ARTICLE",
      "SECTION",
      "DIV",
      "HEADER",
      "FOOTER",
      "MAIN",
      "ASIDE",
      "NAV",
      "FIGURE",
      "FIGCAPTION",
    ]);
    let cur = el;
    for (let i = 0; i < 8; i++) {
      if (!cur || cur === document.body) break;
      if (BLOCK_TAGS.has(cur.tagName)) return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  // ── Floating Mood Picker ──────────────────────────────────────────────────────
  function closePicker() {
    if (targetPicker) {
      targetPicker.remove();
      targetPicker = null;
    }
  }

  function dismissPicker() {
    closePicker();
    if (pickerFrozen || targetModeActive) {
      deactivateTargetMode();
      try {
        chrome.runtime
          .sendMessage({ type: "SET_MODE", mode: "manual" })
          .catch(() => {});
      } catch (_) {}
    }
  }

  function showPicker(targetEl, clientX, clientY) {
    closePicker();
    try {
      chrome.storage.local.get(["custom_moods"], (data) => {
        const customMoods = data?.custom_moods || [];
        renderPicker(targetEl, clientX, clientY, customMoods);
      });
    } catch (_) {
      renderPicker(targetEl, clientX, clientY, []);
    }
  }

  function renderPicker(targetEl, clientX, clientY, customMoods) {
    const picker = document.createElement("div");
    picker.className = "mytake-picker";
    targetPicker = picker;

    const allMoods = [
      ...PICKER_MOODS,
      ...customMoods.map((m) => ({
        id: m.id,
        name: m.name,
        desc: m.desc,
        color: (m.gradient?.match(/#[0-9a-fA-F]{6}/) || [])[0] || "#a78bfa",
        prompt: m.prompt,
        isCustom: true,
      })),
    ];

    const key = makePageKey(targetEl);
    const existingRegion = targetRegions[key];

    picker.innerHTML = `
      <div class="mytake-picker-header">
        <span>Apply tone to selection</span>
        <button class="mytake-picker-close" title="Close">✕</button>
      </div>
    `;

    picker
      .querySelector(".mytake-picker-close")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        dismissPicker();
      });

    for (const m of allMoods) {
      const isAlreadyDone = existingRegion?.mood === m.id;
      const item = document.createElement("div");
      item.className =
        "mytake-picker-item" + (isAlreadyDone ? " already-done" : "");
      item.innerHTML = `
        <span class="mytake-swatch" style="background:${m.color}"></span>
        <span class="mytake-picker-label">${m.name}</span>
        <span class="mytake-picker-desc">${m.desc}</span>
      `;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        closePicker();
        targetEl.classList.remove("mytake-target-locked");
        targetEl.classList.add("mytake-target-processing");
        showProcessingBadge(targetEl);
        applyTargetMood(targetEl, m.id, m.prompt || null);
      });
      picker.appendChild(item);
    }

    const div = document.createElement("div");
    div.className = "mytake-picker-divider";
    picker.appendChild(div);

    const customBtn = document.createElement("div");
    customBtn.className = "mytake-picker-custom";
    customBtn.innerHTML = `<span>✦</span><span>Create Custom…</span>`;
    customBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closePicker();
      openCustomMoodInlineForm(targetEl);
    });
    picker.appendChild(customBtn);

    document.body.appendChild(picker);

    const vw = window.innerWidth,
      vh = window.innerHeight;
    const pw = picker.offsetWidth || 220,
      ph = picker.offsetHeight || 300;
    let x = clientX + 12,
      y = clientY + 8;
    if (x + pw > vw - 8) x = clientX - pw - 8;
    if (y + ph > vh - 8) y = clientY - ph - 8;
    picker.style.left = Math.max(8, x) + "px";
    picker.style.top = Math.max(8, y) + "px";

    setTimeout(() => {
      function outsideClick(ev) {
        if (!targetPicker) {
          document.removeEventListener("click", outsideClick, false);
          return;
        }
        if (targetPicker.contains(ev.target)) return;
        document.removeEventListener("click", outsideClick, false);
        dismissPicker();
      }
      document.addEventListener("click", outsideClick, false);
    }, 300);
  }

  function openCustomMoodInlineForm(targetEl) {
    const form = document.createElement("div");
    form.id = "mytake-custom-form";
    form.style.cssText = `
      position:fixed; z-index:2147483647; top:50%; left:50%; transform:translate(-50%,-50%);
      background:#fff; border-radius:16px; box-shadow:0 20px 60px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.06);
      padding:20px; width:300px; max-width:90vw; font-family:-apple-system,sans-serif; cursor:default;
    `;
    form.innerHTML = `
      <div style="font-weight:800;font-size:15px;margin-bottom:14px;color:#111">Create Custom Mood</div>
      <div style="margin-bottom:10px">
        <label style="display:block;font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Name</label>
        <input id="ml-cname" placeholder="e.g. Pirate, Shakespearean…" maxlength="20"
          style="width:100%;padding:9px 11px;border-radius:8px;border:1.5px solid #e2e2e2;font-size:13px;box-sizing:border-box;outline:none;font-family:inherit;cursor:text"/>
      </div>
      <div style="margin-bottom:14px">
        <label style="display:block;font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Style Description</label>
        <input id="ml-cdesc" placeholder="e.g. Speak like a pirate, Arrrr!" maxlength="80"
          style="width:100%;padding:9px 11px;border-radius:8px;border:1.5px solid #e2e2e2;font-size:13px;box-sizing:border-box;outline:none;font-family:inherit;cursor:text"/>
      </div>
      <div style="display:flex;gap:8px">
        <button id="ml-ccancel" style="flex:1;padding:9px;border-radius:999px;border:1.5px solid #e2e2e2;background:#fff;font-size:13px;font-weight:600;cursor:pointer">Cancel</button>
        <button id="ml-csave"   style="flex:1;padding:9px;border-radius:999px;border:0;background:#111;color:#fff;font-size:13px;font-weight:700;cursor:pointer">Apply</button>
      </div>
    `;
    document.body.appendChild(form);

    const cname = form.querySelector("#ml-cname");
    const cdesc = form.querySelector("#ml-cdesc");
    cname.focus();

    function closeForm() {
      form.remove();
      deactivateTargetMode();
      try {
        chrome.runtime
          .sendMessage({ type: "SET_MODE", mode: "manual" })
          .catch(() => {});
      } catch (_) {}
    }

    form.querySelector("#ml-ccancel").addEventListener("click", closeForm);
    form.querySelector("#ml-csave").addEventListener("click", () => {
      const name = cname.value.trim(),
        desc = cdesc.value.trim();
      if (!name || !desc) {
        (name ? cdesc : cname).focus();
        return;
      }
      const prompt = `You rephrase text in a ${name} style. ${desc}. Output ONLY the rephrased text, nothing else.`;
      const id =
        "custom-" +
        name.toLowerCase().replace(/[^a-z0-9]/g, "-") +
        "-" +
        Date.now();
      const newMood = {
        id,
        name,
        desc,
        prompt,
        gradient: "linear-gradient(135deg,#f472b6,#a78bfa)",
      };
      try {
        chrome.runtime
          .sendMessage({ type: "SAVE_CUSTOM_MOOD", mood: newMood })
          .catch(() => {});
      } catch (_) {}
      form.remove();
      targetEl.classList.remove("mytake-target-locked");
      targetEl.classList.add("mytake-target-processing");
      showProcessingBadge(targetEl);
      applyTargetMood(targetEl, id, prompt);
    });

    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeForm();
      }
    });
  }

  // ── Floating Processing / Error Badges ─────────────────────────────────────
  let processingBadgeEl = null;

  function showProcessingBadge(targetEl) {
    removeProcessingBadge();
    const badge = document.createElement("div");
    badge.id = "mytake-processing-badge";
    badge.innerHTML = `
      <span class="mlbadge-spinner"></span>
      <span class="mlbadge-text">Applying…</span>
    `;
    document.body.appendChild(badge);
    processingBadgeEl = badge;
    positionProcessingBadge(targetEl);

    badge._targetEl = targetEl;
    badge._onScroll = () => positionProcessingBadge(targetEl);
    window.addEventListener("scroll", badge._onScroll, { passive: true });
    window.addEventListener("resize", badge._onScroll, { passive: true });
  }

  function showErrorBadge(targetEl, errorMsg, onClose) {
    removeProcessingBadge();
    const badge = document.createElement("div");
    badge.id = "mytake-processing-badge";
    badge.style.background = "#ef4444";
    badge.style.pointerEvents = "auto"; // Ensure close button is clickable
    badge.innerHTML = `
      <span class="mlbadge-text" style="margin-right:12px; font-weight:700;">Error: ${errorMsg}</span>
      <button id="mlbadge-close" style="background:rgba(255,255,255,0.25); border:none; color:#fff; border-radius:50%; width:18px; height:18px; cursor:pointer; display:grid; place-items:center; font-size:10px; flex-shrink:0;">✕</button>
    `;

    document.body.appendChild(badge);
    processingBadgeEl = badge;

    badge.querySelector("#mlbadge-close").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      onClose();
    });

    positionProcessingBadge(targetEl);
    badge._targetEl = targetEl;
    badge._onScroll = () => positionProcessingBadge(targetEl);
    window.addEventListener("scroll", badge._onScroll, { passive: true });
    window.addEventListener("resize", badge._onScroll, { passive: true });
  }

  function positionProcessingBadge(targetEl) {
    const badge = processingBadgeEl;
    if (!badge || !targetEl.isConnected) return;

    const rect = targetEl.getBoundingClientRect();
    const bw = badge.offsetWidth || 110;
    const bh = badge.offsetHeight || 28;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = rect.right - bw;
    let y = rect.top - bh - margin;

    if (y < margin) y = rect.bottom + margin;
    if (x + bw > vw - margin) x = vw - bw - margin;
    if (x < margin) x = margin;
    if (y + bh > vh - margin) y = vh - bh - margin;
    if (y < margin) y = margin;

    badge.style.left = x + "px";
    badge.style.top = y + "px";
  }

  function removeProcessingBadge() {
    if (!processingBadgeEl) return;
    if (processingBadgeEl._onScroll) {
      window.removeEventListener("scroll", processingBadgeEl._onScroll);
      window.removeEventListener("resize", processingBadgeEl._onScroll);
    }
    processingBadgeEl.remove();
    processingBadgeEl = null;
  }

  // ── Apply mood to a specific element ─────────────────────────────────────────
  const TARGET_MOOD_PROMPTS = {
    original:
      "You rephrase text in a clean, neutral, everyday style. Keep the exact meaning. Output ONLY the rephrased text, nothing else.",
    explain:
      "You explain text in very simple terms, like you're talking to a 5-year-old. Break down complex concepts into basic ideas. Output ONLY the simplified text, nothing else.",
    donald:
      "You rephrase text in the speaking style of Donald J. Trump. Use his characteristic speech patterns, repetition, superlatives, and exclamations. Output ONLY the rephrased text, nothing else.",
    cherry:
      "You rephrase text in a warm, cheerful, uplifting tone — like a good friend sharing great news. Add a little brightness without changing the facts. Output ONLY the rephrased text, nothing else.",
    honest:
      "You rephrase text in a direct, clear, no-fluff style. Cut jargon. Say exactly what is meant. Output ONLY the rephrased text, nothing else.",
    "brutally-honest":
      "You rephrase text in a blunt, no-nonsense tone. Strip all softening language. Say it straight, even if it stings. Never soften the message. Output ONLY the rephrased text, nothing else.",
    academic:
      "You rephrase text in a formal academic register — precise terminology, measured tone, passive constructions where natural. Output ONLY the rephrased text, nothing else.",
    casual:
      "You rephrase text like a laid-back friend texting — short, relaxed, maybe a little playful. Keep the meaning, lose the formality. Output ONLY the rephrased text, nothing else.",
    poetic:
      "You rephrase text with gentle poetic flair — evocative word choices, a light rhythm, nothing flowery. Still clear, just beautiful. Output ONLY the rephrased text, nothing else.",
  };

  async function applyTargetMood(targetEl, moodId, customPromptStr) {
    console.log(`${TAG} [Target] Applying mood "${moodId}" to`, targetEl);
    saveTargetRegion(targetEl, moodId, customPromptStr);

    if (moodId === "original") {
      const walker = document.createTreeWalker(targetEl, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (n._mytakeOriginal) {
          n.textContent = n._mytakeOriginal;
          n._mytakeRephrased = undefined;
        }
      }
      deactivateTargetMode();
      return;
    }

    const systemPrompt =
      customPromptStr ||
      TARGET_MOOD_PROMPTS[moodId] ||
      TARGET_MOOD_PROMPTS.original;

    // ── HARD LOCK ENGAGED ──
    isTargetProcessing = true;
    targetEl.classList.add("mytake-target-processing");

    const targetNodes = [];
    const walker = document.createTreeWalker(targetEl, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.parentElement) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(n.parentElement.tagName.toUpperCase()))
          return NodeFilter.FILTER_REJECT;
        if (isExcludedAncestry(n)) return NodeFilter.FILTER_REJECT;
        const text = n.textContent.trim();
        if (text.length < MIN_CHARS || text.length > MAX_CHARS)
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let n;
    while ((n = walker.nextNode())) {
      if (n._mytakeOriginal === undefined)
        n._mytakeOriginal = n.textContent.trim();
      n._mytakeTargetMood = moodId;

      // Fast-path: use cached result if available
      const cached = getFromCache(n._mytakeOriginal, moodId);
      if (cached) {
        n._mytakeRephrased = cached;
        n.textContent = cached;
        processedNodes.add(n);
        continue;
      }

      n._mytakeRephrased = undefined;
      targetNodes.push(n);
    }

    if (targetNodes.length === 0) {
      targetEl.classList.remove("mytake-target-processing");
      removeProcessingBadge();
      targetEl.classList.add("mytake-target-done");
      setTimeout(() => targetEl.classList.remove("mytake-target-done"), 1400);
      isTargetProcessing = false;
      deactivateTargetMode();
      try {
        chrome.runtime
          .sendMessage({ type: "SET_MODE", mode: "manual" })
          .catch(() => {});
      } catch (_) {}
      return;
    }

    let remaining = targetNodes.length;
    let hasError = false;
    let lastErrorMessage = "";

    function onTargetNodeDone(errorMsg) {
      if (errorMsg) {
        hasError = true;
        lastErrorMessage = errorMsg;
      }

      remaining--;
      if (remaining <= 0) {
        // Unlock global clicks
        isTargetProcessing = false;

        if (hasError) {
          // ── PERSISTENT ERROR STATE ──
          targetEl.classList.remove("mytake-target-processing");
          targetEl.classList.add("mytake-target-error");

          showErrorBadge(targetEl, lastErrorMessage, () => {
            targetEl.classList.remove("mytake-target-error");
            removeProcessingBadge();
            deactivateTargetMode();
            try {
              chrome.runtime
                .sendMessage({ type: "SET_MODE", mode: "manual" })
                .catch(() => {});
            } catch (_) {}
          });
        } else {
          // ── SUCCESS STATE ──
          targetEl.classList.remove("mytake-target-processing");
          removeProcessingBadge();
          targetEl.classList.add("mytake-target-done");
          setTimeout(
            () => targetEl.classList.remove("mytake-target-done"),
            1400,
          );

          deactivateTargetMode();
          try {
            chrome.runtime
              .sendMessage({ type: "SET_MODE", mode: "manual" })
              .catch(() => {});
          } catch (_) {}
        }
      }
    }

    for (const node of targetNodes) {
      const requestId = `tgt_${++requestCounter}`;
      inflightRequests.set(requestId, node);
      inflightNodes.add(node);
      inflightRequestCallbacks.set(requestId, onTargetNodeDone);
      postToMain("TARGET_REPHRASE_REQUEST", {
        requestId,
        text: node._mytakeOriginal,
        systemPrompt,
      });
    }

    broadcastProgress({ targetMode: true });
  }

  // ── Chrome runtime message listener ─────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_AI_STATUS") {
      sendResponse({ available: aiReady, error: aiError });
      return true;
    }
    if (msg.type === "POPUP_STATE") {
      popupOpen = !!msg.open;
      if (popupOpen) broadcastProgress();
    }
    if (msg.type === "TARGET_MODE_ACTIVATE") activateTargetMode();
    if (msg.type === "TARGET_MODE_DEACTIVATE") deactivateTargetMode();
    if (msg.type === "MOOD_CHANGED") resetAndReinit(msg.mood, msg.customPrompt);

    if (msg.type === "INTENSITY_CHANGED") {
      intensity = msg.intensity;
      resetAndReinit(mood, customPrompt);
    }

    if (msg.type === "ENABLED_CHANGED") {
      enabled = msg.enabled;
      if (!enabled) {
        pendingNodes.clear();
        inflightRequests.clear();
        commandInflightRequests.clear();
        inflightNodes = new WeakSet();
        commandQueue = [];
        commandRunning = false;
        manualRunning = false;
        if (batchTimer) clearTimeout(batchTimer);
        broadcastProgress();
        restoreOriginals();
        destroySession();
      } else {
        resetAndReinit(mood, customPrompt);
      }
    }
    if (msg.type === "PAUSED_CHANGED") {
      paused = msg.paused;
      if (paused) {
        // 1. Tell the AI Bridge to instantly drop the queue
        postToMain("DESTROY_SESSION");

        // 2. Move any AI requests that were mid-flight safely back into pending
        for (const [reqId, node] of inflightRequests.entries()) {
          pendingNodes.add(node);
          inflightNodes.delete(node);
        }
        inflightRequests.clear();

        // 3. Stop running and freeze the background DOM scanners
        manualRunning = false;
        if (batchTimer) clearTimeout(batchTimer);
        nodesToScan.clear();
        if (observerStarted) {
          observer.disconnect();
          observerStarted = false;
        }

        // Counter is now 100% frozen
        broadcastProgress();
      } else {
        // RESUME
        startObserver(); // Wake up scanners
        scheduleScan(document.body); // Do a fresh sweep to catch anything missed while paused

        if (pendingNodes.size > 0) {
          manualRunning = true;
          scheduleBatch();
        }
        broadcastProgress();
      }
    }

    if (msg.type === "RESTART_REPHRASE") restartRephrasing();

    if (msg.type === "MODE_CHANGED") {
      mode = msg.mode;

    }

    if (msg.type === "TRIGGER_REWRITE") triggerManualRewrite();
    if (msg.type === "RUN_COMMAND") runCommand(msg.commandText);
    if (msg.type === "RUN_COMMANDS") runMultipleCommands(msg.commands);
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  console.log(`${TAG} Content script loaded (ISOLATED world)`);
  loadTargetRegions();

  Promise.all([
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
          if (chrome.runtime.lastError)
            resolve({ mood: "original", enabled: true, mode: "manual" });
          else resolve(state);
        });
      } catch (err) {
        resolve({ mood: "original", enabled: true, mode: "manual" });
      }
    }),
    loadCache(),
  ]).then(([state]) => {
    mood = state?.mood || "original";
    enabled = state?.enabled !== false;
    mode = state?.mode || "manual";
    customPrompt = state?.customPrompt || null;
    intensity = state?.intensity || 2;
    paused = state?.paused === true;

    if (mode === "target") activateTargetMode();
    if (enabled) postToMain("PING");
  });
})();
