// content.js — MoodLens v2.0 ISOLATED world content script
// Handles: mood rephrasing (auto/manual), AI commands, DOM scanning,
// MutationObserver, local caching, and streaming text updates.

(() => {
  const TAG = '[MoodLens]';
  const CHANNEL = 'MOODLENS_BRIDGE';

  // ── Config ──────────────────────────────────────────────────────────────────
  const MIN_CHARS      = 5;
  const MAX_CHARS      = 800;
  const BATCH_DELAY_MS = 100;
  const MAX_BATCH_SIZE = 20;

  const SKIP_TAGS = new Set([
    'SCRIPT','STYLE','NOSCRIPT','TEMPLATE','CODE','PRE',
    'KBD','VAR','SAMP','MATH','SVG','TEXTAREA','INPUT',
    'SELECT','BUTTON','OPTION','HEAD','TITLE'
  ]);

  // ── State ───────────────────────────────────────────────────────────────────
  let mood          = 'standard';
  let customPrompt  = null;
  let enabled       = true;
  let mode          = 'manual'; // 'auto' | 'manual'
  let aiReady       = false;
  let pendingNodes  = new Set();
  let batchTimer    = null;
  let processedNodes = new WeakSet();
  let requestCounter = 0;
  let intensity     = 2;
  let popupOpen     = false;
  let manualRunning = false;
  let paused        = false;

  // Track nodes currently being processed by AI (inflight)
  let inflightNodes = new WeakSet();

  // ── Viewport Observer for Lazy Translation ────────────────────────────────
  const viewportObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const parent = entry.target;
        if (parent._moodlensTextNodes) {
          for (const n of parent._moodlensTextNodes) {
            if (n.isConnected && n.textContent.trim()) {
              pendingNodes.add(n);
            }
          }
          if (parent._moodlensTextNodes.size > 0 && mode === 'auto') scheduleBatch();
          parent._moodlensTextNodes.clear();
        }
        viewportObserver.unobserve(parent);
      }
    }
  }, { rootMargin: '400px' });

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
        chrome.storage.local.get(['moodlens_cache'], (res) => {
          if (res && res.moodlens_cache) {
            cacheMap = res.moodlens_cache;
            console.log(`${TAG} Loaded ${Object.keys(cacheMap).length} cached translations.`);
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

  function saveToCache(originalText, rephrasedText) {
    if (!originalText || !rephrasedText) return;
    const trimOrig = originalText.trim();
    const trimReph = rephrasedText.trim();
    if (trimOrig === trimReph || trimOrig.length < MIN_CHARS) return;

    const key = `${mood}_${trimOrig}`;
    cacheMap[key] = trimReph;

    const keys = Object.keys(cacheMap);
    if (keys.length > 2000) {
      for (let i = 0; i < 200; i++) delete cacheMap[keys[i]];
    }

    if (saveCacheTimer) clearTimeout(saveCacheTimer);
    saveCacheTimer = setTimeout(() => {
      try { chrome.storage.local.set({ moodlens_cache: cacheMap }); }
      catch (err) { console.warn(`${TAG} Cache save failed:`, err); }
    }, 3000);
  }

  function getFromCache(originalText) {
    if (!originalText) return null;
    return cacheMap[`${mood}_${originalText.trim()}`] || null;
  }

  // ── PostMessage bridge to MAIN world ────────────────────────────────────────
  function postToMain(type, data = {}) {
    window.postMessage({ channel: CHANNEL, direction: 'TO_MAIN', type, ...data }, '*');
  }

  // Listen for responses from content-main.js
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.direction !== 'TO_ISOLATED') return;

    if (msg.type === 'BRIDGE_READY' || msg.type === 'PONG') {
      console.log(`${TAG} MAIN bridge responded — AI present: ${msg.hasAI}`);
      if (msg.hasAI && enabled) {
        initSession();
      } else if (!msg.hasAI) {
        aiReady = false;
        console.warn(`${TAG} No AI API available.`);
      }
    }

    if (msg.type === 'AI_STATUS') {
      if (msg.available) {
        aiReady = true;
        console.log(`${TAG} ✅ AI session ready for mood: "${msg.mood}"`);
        scheduleScan(document.body);
        if (mode === 'auto') scheduleBatch();
        startObserver();
      } else {
        aiReady = false;
        console.error(`${TAG} ❌ AI unavailable: ${msg.error}`);
      }
    }

    // ── Mood rephrase streaming ─────────────────────────────────────────────
    if (msg.type === 'REPHRASE_STREAM') {
      const node = inflightRequests.get(msg.requestId);
      if (node && node.isConnected) {
        node._moodlensRephrased = msg.text;
        node.textContent = msg.text;
      }
    }

    if (msg.type === 'REPHRASE_DONE') {
      const node = inflightRequests.get(msg.requestId);
      inflightRequests.delete(msg.requestId);

      if (node && node.isConnected) {
        node._moodlensRephrased = msg.text;
        node.textContent = msg.text;
        processedNodes.add(node);
        inflightNodes.delete(node);
        saveToCache(node._moodlensOriginal, msg.text);
      } else if (node) {
        inflightNodes.delete(node);
      }

      broadcastProgress();
      if (pendingNodes.size > 0 && (mode === 'auto' || manualRunning)) scheduleBatch();
    }

    if (msg.type === 'REPHRASE_FAIL') {
      const node = inflightRequests.get(msg.requestId);
      inflightRequests.delete(msg.requestId);

      if (node) {
        inflightNodes.delete(node);
        if (node.isConnected && node._moodlensOriginal) {
          node._moodlensRephrased = node._moodlensOriginal;
          node.textContent = node._moodlensOriginal;
          node._moodlensRephrased = undefined;
        }
      }

      broadcastProgress();
      if (pendingNodes.size > 0 && (mode === 'auto' || manualRunning)) scheduleBatch();
    }

    // ── Command streaming ───────────────────────────────────────────────────
    if (msg.type === 'COMMAND_STREAM') {
      const entry = commandInflightRequests.get(msg.requestId);
      if (entry && entry.node && entry.node.isConnected) {
        entry.node._moodlensRephrased = msg.text;
        entry.node.textContent = msg.text;
      }
    }

    if (msg.type === 'COMMAND_DONE') {
      const entry = commandInflightRequests.get(msg.requestId);
      commandInflightRequests.delete(msg.requestId);

      if (entry && entry.node && entry.node.isConnected) {
        entry.node._moodlensRephrased = msg.text;
        entry.node.textContent = msg.text;
        processedNodes.add(entry.node);
        inflightNodes.delete(entry.node);
      }

      broadcastProgress();
      processNextCommandBatch();
    }

    if (msg.type === 'COMMAND_FAIL') {
      const entry = commandInflightRequests.get(msg.requestId);
      commandInflightRequests.delete(msg.requestId);

      if (entry && entry.node) {
        inflightNodes.delete(entry.node);
        if (entry.node.isConnected && entry.originalText) {
          entry.node._moodlensRephrased = entry.originalText;
          entry.node.textContent = entry.originalText;
          entry.node._moodlensRephrased = undefined;
        }
      }

      broadcastProgress();
      processNextCommandBatch();
    }
  });

  // ── Session management ──────────────────────────────────────────────────────
  function initSession() {
    if (mood === 'standard') {
      console.log(`${TAG} Standard mood. Bypassing AI session.`);
      aiReady = true;
      scheduleScan(document.body); // still scan so standard can restore originals
      startObserver();
      return;
    }
    console.log(`${TAG} Requesting AI session for mood: "${mood}" (intensity: ${intensity})`);
    postToMain('INIT_SESSION', { mood, customPrompt: customPrompt || undefined, intensity });
  }

  function destroySession() {
    postToMain('DESTROY_SESSION');
    aiReady = false;
  }

  // ── Broadcast progress to popup ─────────────────────────────────────────────
  function broadcastProgress() {
    if (!popupOpen) return;
    try {
      const active = (mode === 'auto' && (pendingNodes.size > 0 || inflightRequests.size > 0)) ||
                     (manualRunning) ||
                     (inflightRequests.size > 0 || commandInflightRequests.size > 0);
      chrome.runtime.sendMessage({
        type: 'PROGRESS_UPDATE',
        pending: pendingNodes.size + inflightRequests.size + commandInflightRequests.size,
        active: active,
        paused: paused
      }).catch(() => {});
    } catch (_) {}
  }

  // ── Queue / batch ──────────────────────────────────────────────────────────
  function queueNode(node) {
    if (!enabled || paused) return;

    const currentText = node.textContent.trim();
    if (!currentText) return;

    if (mood === 'standard') {
      if (node._moodlensOriginal !== undefined && currentText !== node._moodlensOriginal) {
        node.textContent = node._moodlensOriginal;
        node._moodlensRephrased = undefined;
      }
      return;
    }

    if (!aiReady) return;
    if (processedNodes.has(node)) return;
    if (inflightNodes.has(node)) return;

    if (node._moodlensRephrased !== undefined && currentText === node._moodlensRephrased) return;

    if (node._moodlensRephrased !== undefined && currentText !== node._moodlensRephrased) {
      node._moodlensOriginal = currentText;
      node._moodlensRephrased = undefined;
    } else if (node._moodlensOriginal === undefined) {
      node._moodlensOriginal = currentText;
    }

    const original = node._moodlensOriginal;
    if (original.length < MIN_CHARS || original.length > MAX_CHARS) return;
    // Note: isVisible check removed — it only checked direct parent and silently
    // dropped many valid nodes (e.g. nodes inside nested containers). The
    // isConnected check in processBatch handles truly disconnected nodes.

    const cached = getFromCache(original);
    if (cached) {
      node._moodlensRephrased = cached;
      node.textContent = cached;
      processedNodes.add(node);
      return;
    }

    pendingNodes.add(node);
    if (mode === 'auto') {
      scheduleBatch();
    }
  }

  function scheduleBatch() {
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(processBatch, BATCH_DELAY_MS);
    broadcastProgress();
  }

  async function processBatch() {
    if (!enabled || !aiReady || mood === 'standard') {
      if (mood === 'standard' && pendingNodes.size > 0) pendingNodes.clear();
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

      const original = node._moodlensOriginal;
      if (!original || original.length < MIN_CHARS) continue;

      const requestId = `req_${++requestCounter}`;
      inflightRequests.set(requestId, node);
      inflightNodes.add(node);
      postToMain('REPHRASE_REQUEST', { requestId, text: original });
    }

    if (pendingNodes.size > 0 && (mode === 'auto' || manualRunning)) {
      scheduleBatch();
    } else if (pendingNodes.size === 0) {
      manualRunning = false;
    }
  }

  // ── Manual trigger: flush all pending ──────────────────────────────────────
  function triggerManualRewrite() {
    if (!enabled || paused || !aiReady || mood === 'standard') return;
    console.log(`${TAG} Manual trigger — flushing ${pendingNodes.size} pending nodes`);
    manualRunning = true;
    processBatch();
  }

  // ── Restart Translation from Scratch ────────────────────────────────────────
  function restartRephrasing() {
    console.log(`${TAG} Restarting rephrasing on page...`);
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
    if (mode === 'auto' && !paused) {
      scheduleBatch();
    }
    broadcastProgress();
  }

  // ── Smart Targeted Command Heuristic Engine ────────────────────────────────
  function getTargetedNodesForCommand(commandText, allNodes) {
    const cmd = commandText.toLowerCase();
    console.log(`${TAG} [Heuristic] Evaluating ${allNodes.length} nodes for command keyword targeting...`);

    let filtered = [];

    // 1. Currency / Prices / Money
    if (/\b(price|money|cost|dollar|eur|usd|inr|rupee|currency|conversion|convert|prizes|exchange)\b/.test(cmd)) {
      filtered = allNodes.filter(n => {
        const text = n.textContent;
        return /[$€£₹¥]|(\d+(\.\d+)?)\s*(usd|eur|gbp|inr|dollars|euros|rupees)?/i.test(text);
      });
      console.log(`${TAG} [Heuristic] Price/Currency match: isolated ${filtered.length}/${allNodes.length} nodes.`);
      return filtered;
    }

    // 2. Numbers / Math / Units
    if (/\b(number|digit|math|unit|convert|measurement|miles|km|kg|lbs|celsius|fahrenheit)\b/.test(cmd)) {
      filtered = allNodes.filter(n => /\d/.test(n.textContent));
      console.log(`${TAG} [Heuristic] Numeric match: isolated ${filtered.length}/${allNodes.length} nodes.`);
      return filtered;
    }

    // 3. Email / Phone / Links / Contact info
    if (/\b(email|phone|link|url|contact)\b/.test(cmd)) {
      filtered = allNodes.filter(n => {
        const text = n.textContent;
        return /@|\+?\d{7,15}|https?:\/\//i.test(text);
      });
      console.log(`${TAG} [Heuristic] Contact/Link match: isolated ${filtered.length}/${allNodes.length} nodes.`);
      return filtered;
    }

    // 4. Names / Places / Proper Nouns (Capitalized)
    if (/\b(name|people|place|city|country|location|proper noun|person)\b/.test(cmd)) {
      filtered = allNodes.filter(n => {
        const text = n.textContent.trim();
        return /[A-Z][a-z]+/.test(text);
      });
      console.log(`${TAG} [Heuristic] Proper Noun match: isolated ${filtered.length}/${allNodes.length} nodes.`);
      return filtered;
    }

    // 5. General text operations: if user is asking to summarize/shorten/simplify,
    // we prioritize text blocks that are long enough to actually make sense of.
    if (/\b(summarize|shorten|simplify|explain|rewrite|rephrase)\b/.test(cmd)) {
      filtered = allNodes.filter(n => n.textContent.trim().length > 30);
      console.log(`${TAG} [Heuristic] Summarization/Simplification match: isolated ${filtered.length}/${allNodes.length} nodes.`);
      return filtered;
    }

    // Default fallback: return nodes that are sufficiently long (length > 25)
    // to avoid translating tiny layout items like "Home", "Cart", "OK".
    filtered = allNodes.filter(n => n.textContent.trim().length > 25);
    console.log(`${TAG} [Heuristic] Default fallback: isolated ${filtered.length}/${allNodes.length} nodes.`);
    return filtered;
  }

  // ── AI Command Execution ───────────────────────────────────────────────────
  function runCommand(commandText) {
    if (!enabled) return;
    console.log(`${TAG} Running command: "${commandText}"`);

    const rawNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.parentElement) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(n.parentElement.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
        if (isExcludedAncestry(n)) return NodeFilter.FILTER_REJECT;
        const text = n.textContent.trim();
        if (text.length < MIN_CHARS || text.length > MAX_CHARS) return NodeFilter.FILTER_REJECT;
        if (!isVisible(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let n;
    while ((n = walker.nextNode())) {
      if (inflightNodes.has(n)) continue;
      rawNodes.push(n);
    }

    // Apply the Smart Targeted Heuristic Engine
    const nodes = getTargetedNodesForCommand(commandText, rawNodes);

    if (nodes.length === 0) {
      console.log(`${TAG} No eligible nodes for command.`);
      return;
    }

    // Store original text
    for (const node of nodes) {
      if (node._moodlensOriginal === undefined) {
        node._moodlensOriginal = node.textContent.trim();
      }
    }

    commandQueue.push({ commandText, nodes });
    if (!commandRunning) processNextCommandBatch();
  }

  function runMultipleCommands(commands) {
    for (const cmd of commands) {
      runCommand(cmd);
    }
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

      const original = node._moodlensOriginal || node.textContent.trim();
      if (!original || original.length < MIN_CHARS) continue;

      const requestId = `cmd_${++requestCounter}`;
      commandInflightRequests.set(requestId, { node, originalText: original });
      inflightNodes.add(node);
      postToMain('COMMAND_REQUEST', { requestId, text: original, commandText });
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
            if (SKIP_TAGS.has(n.parentElement.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
            if (isExcludedAncestry(n)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
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
      if (mutation.type === 'characterData') {
        const target = mutation.target;
        if (processedNodes.has(target)) continue;
        if (inflightNodes.has(target)) continue;
        const newText = target.textContent.trim();
        if (target._moodlensRephrased !== undefined && newText === target._moodlensRephrased) continue;
        queuedMutations.add(target);
      } else if (mutation.type === 'childList') {
        for (const added of mutation.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE || added.nodeType === Node.ELEMENT_NODE) {
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
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    console.log(`${TAG} MutationObserver started`);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function isVisible(node) {
    const el = node.parentElement;
    if (!el) return false;
    try {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    } catch (_) {}
    return true;
  }

  // ── Restore all text to originals ─────────────────────────────────────────
  function restoreOriginals() {
    let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n._moodlensOriginal) {
        n.textContent = n._moodlensOriginal;
        n._moodlensRephrased = undefined;
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
    inflightNodes = new WeakSet(); // reset inflight — critical for session changes
    commandQueue = [];
    commandRunning = false;
    if (batchTimer) clearTimeout(batchTimer);

    restoreOriginals();
    processedNodes = new WeakSet();

    mood = moodKey;
    customPrompt = newCustomPrompt || null;

    if (mood === 'standard') {
      broadcastProgress();
      initSession();
      return;
    }

    // Fast-path: apply cached translations
    let cacheHits = 0, totalFound = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n._moodlensOriginal) {
        totalFound++;
        const cached = getFromCache(n._moodlensOriginal);
        if (cached) {
          n._moodlensRephrased = cached;
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

  // ── Chrome runtime messaging ───────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    console.log(`${TAG} Got message:`, msg.type);

    if (msg.type === 'POPUP_STATE') {
      popupOpen = !!msg.open;
      console.log(`${TAG} Popup open state changed: ${popupOpen}`);
      if (popupOpen) {
        broadcastProgress();
      }
    }

    if (msg.type === 'MOOD_CHANGED') {
      resetAndReinit(msg.mood, msg.customPrompt);
    }

    if (msg.type === 'INTENSITY_CHANGED') {
      console.log(`${TAG} Intensity changed to: ${msg.intensity}`);
      intensity = msg.intensity;
      resetAndReinit(mood, customPrompt);
    }

    if (msg.type === 'ENABLED_CHANGED') {
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

    if (msg.type === 'PAUSED_CHANGED') {
      paused = msg.paused;
      console.log(`${TAG} Paused state changed to: ${paused}`);
      if (!paused && (mode === 'auto' || manualRunning) && pendingNodes.size > 0) {
        scheduleBatch();
      }
      broadcastProgress();
    }

    if (msg.type === 'RESTART_REPHRASE') {
      restartRephrasing();
    }

    if (msg.type === 'MODE_CHANGED') {
      mode = msg.mode;
      console.log(`${TAG} Mode changed to: ${mode}`);
      if (mode === 'auto' && pendingNodes.size > 0 && !paused) {
        scheduleBatch();
      }
    }

    if (msg.type === 'TRIGGER_REWRITE') {
      triggerManualRewrite();
    }

    if (msg.type === 'RUN_COMMAND') {
      runCommand(msg.commandText);
    }

    if (msg.type === 'RUN_COMMANDS') {
      runMultipleCommands(msg.commands);
    }
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  console.log(`${TAG} Content script loaded (ISOLATED world)`);

  Promise.all([
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
          if (chrome.runtime.lastError) {
            console.warn(`${TAG} GET_STATE error:`, chrome.runtime.lastError.message);
            resolve({ mood: 'standard', enabled: true, mode: 'manual' });
          } else {
            resolve(state);
          }
        });
      } catch (err) {
        console.warn(`${TAG} GET_STATE failed:`, err);
        resolve({ mood: 'standard', enabled: true, mode: 'manual' });
      }
    }),
    loadCache()
  ]).then(([state]) => {
    mood          = state?.mood    || 'standard';
    enabled       = state?.enabled !== false;
    mode          = state?.mode    || 'manual';
    customPrompt  = state?.customPrompt || null;
    intensity     = state?.intensity || 2;
    paused        = state?.paused === true;
    console.log(`${TAG} Boot — mood: "${mood}", enabled: ${enabled}, mode: ${mode}, intensity: ${intensity}, paused: ${paused}`);

    if (enabled) {
      postToMain('PING');
    }
  });
})();
