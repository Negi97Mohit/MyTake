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
  let intensity = 2;
  let popupOpen = false;
  let manualRunning = false;
  let paused = false;

  // Strict Token Bucket & State Idempotency
  const nodeState = new WeakMap(); // QUEUED, PROCESSING, COMPLETED
  let activeRequests = 0;
  const MAX_CONCURRENT_REQUESTS = 2;

  // Per-request completion callbacks (used by target mode)
  const inflightRequestCallbacks = new Map();

  let inflightNodes = new WeakSet();

  function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
  }

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
  // Map of requestId → array of child tag names at request time
  const inflightSnapshots = new Map();

  // =========================================================================
  // SECTION: UNDO STACK
  // =========================================================================
  // A small capped in-memory stack, push-only for now, to support undoing
  // DOM changes like remove and insert.
  const undoStack = {
    maxSize: 50,
    stack: [],
    push(item) {
      this.stack.push(item);
      if (this.stack.length > this.maxSize) {
        this.stack.shift();
      }
    },
    pop() {
      return this.stack.pop();
    },
    clear() {
      this.stack = [];
    }
  };

  // =========================================================================
  // SECTION: DOM SNAPSHOT (Observe Phase)
  // =========================================================================
  // Given a target element, produces a compact serialized snapshot of its 
  // direct children (tag, short text/attribute summary, integer index) for 
  // use in classification/generation. Capped to first 20 children and 
  // 40 characters of text per child.
  function getDOMSnapshot(targetEl) {
    if (!targetEl || targetEl.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }
    const targetTag = targetEl.tagName.toLowerCase();
    const targetId = targetEl.id || "";
    const targetClass = targetEl.className || "";
    const targetRole = targetEl.getAttribute("role") || "";
    
    let snapshotStr = `Target Element: <${targetTag}`;
    if (targetId) snapshotStr += ` id="${targetId}"`;
    if (targetClass) snapshotStr += ` class="${targetClass}"`;
    if (targetRole) snapshotStr += ` role="${targetRole}"`;
    snapshotStr += `>\n`;
    
    const children = Array.from(targetEl.children);
    if (children.length === 0) {
      snapshotStr += `(No direct child elements)\n`;
    } else {
      snapshotStr += `Direct Children:\n`;
      const maxChildrenToShow = 20;
      const displayedChildren = children.slice(0, maxChildrenToShow);
      
      displayedChildren.forEach((child, index) => {
        const tag = child.tagName.toLowerCase();
        const id = child.id || "";
        const cls = child.className || "";
        const role = child.getAttribute("role") || "";
        let text = child.textContent ? child.textContent.trim().replace(/\s+/g, " ") : "";
        if (text.length > 40) {
          text = text.substring(0, 37) + "...";
        }
        
        snapshotStr += `- Index ${index}: <${tag}`;
        if (id) snapshotStr += ` id="${id}"`;
        if (cls) snapshotStr += ` class="${cls}"`;
        if (role) snapshotStr += ` role="${role}"`;
        snapshotStr += `> "${text}"\n`;
      });
      
      if (children.length > maxChildrenToShow) {
        snapshotStr += `- +${children.length - maxChildrenToShow} more children not shown\n`;
      }
    }
    return snapshotStr;
  }

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

  const sessionNonce = crypto.randomUUID();
  document.documentElement.dataset.mytakeNonce = sessionNonce;

  // ── PostMessage bridge to MAIN world ────────────────────────────────────────
  function postToMain(type, data = {}) {
    window.postMessage(
      { channel: CHANNEL, direction: "TO_MAIN", type, nonce: sessionNonce, ...data },
      "*"
    );
    
    // Add 30s timeout for these types
    if (["TARGET_REPHRASE_REQUEST", "REPHRASE_REQUEST", "COMMAND_REQUEST"].includes(type)) {
       const reqId = data.requestId;
       setTimeout(() => {
          if (inflightRequests.has(reqId)) {
             window.postMessage({ channel: CHANNEL, direction: "TO_ISOLATED", type: "REPHRASE_FAIL", requestId: reqId, nonce: sessionNonce, error: "Timeout" }, "*");
             window.postMessage({ channel: CHANNEL, direction: "TO_ISOLATED", type: "INTENT_FAIL", requestId: reqId, nonce: sessionNonce, error: "Timeout" }, "*");
          }
          if (commandInflightRequests.has(reqId)) {
             window.postMessage({ channel: CHANNEL, direction: "TO_ISOLATED", type: "COMMAND_FAIL", requestId: reqId, nonce: sessionNonce, error: "Timeout" }, "*");
          }
       }, 30000);
    }
  }

  // Listen for responses from content-main.js
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.direction !== "TO_ISOLATED")
      return;
      
    if (msg.nonce !== sessionNonce) {
      console.warn("[MyTake] Isolated world rejected message with invalid nonce");
      return;
    }

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
        if (chicMenu) {
            const overlay = chicMenu.querySelector("#mt-disclaimer-overlay");
            if (overlay) overlay.classList.add("show");
        }
      }
    }

    if (msg.type === "UPDATE_FLOATING_BTN") {
      if (chicFab) {
        chicFab.style.display = msg.hide ? "none" : "";
      }
    }

    if (msg.type === "AI_STATUS") {
      aiError = msg.error || null;
      if (msg.available) {
        aiReady = true;
        console.log(`${TAG} ✅ AI session ready for mood: "${msg.mood}"`);
        if (chicMenu) {
          const overlay = chicMenu.querySelector("#mt-disclaimer-overlay");
          if (overlay) overlay.classList.remove("show");
        }
        if (mood !== "original") {
          scheduleScan(document.body);
        }
        startObserver();
      } else {
        aiReady = false;
        console.error(`${TAG} ❌ AI unavailable: ${msg.error}`);
        if (chicMenu) {
            const overlay = chicMenu.querySelector("#mt-disclaimer-overlay");
            if (overlay) overlay.classList.add("show");
        }
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

    if (msg.type === "REPHRASE_STREAM") {
      const node = inflightRequests.get(msg.requestId);
      if (node && node.isConnected) {
        node._mytakeRephrased = msg.text;
        if (node.nodeType === Node.ELEMENT_NODE) {
          node.innerText = msg.text;
        } else {
          node.textContent = msg.text;
        }
      }
    }

    if (msg.type === "REPHRASE_DONE") {
      const node = inflightRequests.get(msg.requestId);
      inflightRequests.delete(msg.requestId);

      if (node && node.isConnected) {
        node._mytakeRephrased = msg.text;
        // Prevent infinite loop by locking state
        nodeState.set(node, "COMPLETED");
        if (node.nodeType === Node.ELEMENT_NODE) {
          node.innerText = msg.text;
        } else {
          node.textContent = msg.text;
        }

        // NEW: Tell the cache exactly which mood generated this text
        const appliedMood = node._mytakeTargetMood || mood;
        saveToCache(node._mytakeOriginal, msg.text, appliedMood);
      } else if (node) {
        nodeState.delete(node);
      }
      
      // Token bucket decrement
      if (activeRequests > 0) activeRequests--;

      const cb = inflightRequestCallbacks.get(msg.requestId);
      if (cb) {
        inflightRequestCallbacks.delete(msg.requestId);
        if (typeof cb === "function") cb(null);
        else if (cb.onSuccess) cb.onSuccess();
      }

      broadcastProgress();
      if (pendingNodes.size > 0 && manualRunning)
        processBatch();
    }
    if (msg.type === "REPHRASE_FAIL") {
      const node = inflightRequests.get(msg.requestId);
      inflightRequests.delete(msg.requestId);

      if (activeRequests > 0) activeRequests--;
      if (node) {
        nodeState.delete(node);
        if (node.isConnected && node._mytakeOriginal) {
          node._mytakeRephrased = node._mytakeOriginal;
          if (node.nodeType === Node.ELEMENT_NODE && node._mytakeOriginalHTML) {
            node.innerHTML = node._mytakeOriginalHTML;
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            node.innerText = node._mytakeOriginal;
          } else {
            node.textContent = node._mytakeOriginal;
          }
          node._mytakeRephrased = undefined;
        }
      }

      // Target mode explicit error pass
      const cb = inflightRequestCallbacks.get(msg.requestId);
      if (cb) {
        inflightRequestCallbacks.delete(msg.requestId);
        if (typeof cb === "function") cb(msg.error || "Model crashed");
        else if (cb.onError) cb.onError(msg.error || "Model crashed");
      }

      broadcastProgress();
      if (pendingNodes.size > 0 && manualRunning)
        processBatch();
    }

    // ── Intent streaming / resolution ───────────────────────────────────────
    // =========================================================================
    // SECTION: INTENT RESULT HANDLERS (Act Phase - Execution)
    // =========================================================================
    const resultHandlers = new Map();

    // 1. Rephrase Handler (INTENT_TEXT_DONE)
    resultHandlers.set("INTENT_TEXT_DONE", (msg) => {
      const targetEl = inflightRequests.get(msg.requestId);
      const cb = inflightRequestCallbacks.get(msg.requestId);
      inflightRequests.delete(msg.requestId);
      inflightRequestCallbacks.delete(msg.requestId);
      inflightSnapshots.delete(msg.requestId);
      if (targetEl) {
        if (targetEl === document.body) {
          runCommand(msg.prompt);
          if (cb) {
            if (cb.onSuccess) cb.onSuccess();
          }
        } else {
          const walker = document.createTreeWalker(targetEl, NodeFilter.SHOW_TEXT, {
            acceptNode(n) {
              if (!n.parentElement) return NodeFilter.FILTER_REJECT;
              if (SKIP_TAGS.has(n.parentElement.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
              if (isExcludedAncestry(n)) return NodeFilter.FILTER_REJECT;
              const text = n.textContent.trim();
              if (text.length < MIN_CHARS || text.length > MAX_CHARS) return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
          });
          
          let n;
          const nodeRequests = [];
          while ((n = walker.nextNode())) {
            if (n._mytakeOriginal === undefined) n._mytakeOriginal = n.textContent.trim();
            n._mytakeTargetMood = "custom";
            nodeRequests.push(n);
          }
          
          if (nodeRequests.length === 0) {
            if (cb) {
              if (cb.onSuccess) cb.onSuccess();
            }
            return;
          }
          
          let remaining = nodeRequests.length;
          let hasError = false;
          
          nodeRequests.forEach(node => {
            const reqId = "tgt-" + Date.now() + "-" + Math.random().toString(36).substr(2, 5);
            inflightRequests.set(reqId, node);
            nodeState.set(node, "PROCESSING");
            
            inflightRequestCallbacks.set(reqId, {
              onSuccess: () => {
                remaining--;
                if (remaining <= 0 && cb) {
                  if (hasError) { if (cb.onError) cb.onError("Some elements failed"); }
                  else { if (cb.onSuccess) cb.onSuccess(); }
                }
              },
              onError: () => {
                hasError = true;
                remaining--;
                if (remaining <= 0 && cb) {
                  if (cb.onError) cb.onError("Failed to process some text");
                }
              }
            });
            
            postToMain("TARGET_REPHRASE_REQUEST", {
              requestId: reqId,
              text: node._mytakeOriginal,
              systemPrompt: msg.prompt
            });
          });
        }
      }
    });

    // 2. Style Handler (INTENT_UI_DONE)
    resultHandlers.set("INTENT_UI_DONE", (msg) => {
      const targetEl = inflightRequests.get(msg.requestId);
      const cb = inflightRequestCallbacks.get(msg.requestId);
      inflightRequests.delete(msg.requestId);
      inflightRequestCallbacks.delete(msg.requestId);
      inflightSnapshots.delete(msg.requestId);
      if (targetEl && msg.css) {
        try {
          const styleObj = JSON.parse(msg.css);
          for (const key in styleObj) {
            const kebabKey = key.replace(/([A-Z])/g, "-$1").toLowerCase();
            targetEl.style.setProperty(kebabKey, styleObj[key]);
          }
        } catch(e) {
          targetEl.style.cssText += ";" + msg.css;
        }
      }
      if (cb) {
        if (cb.onSuccess) cb.onSuccess();
      }
    });

    // 3. Regenerate Handler (INTENT_REGENERATE_DONE)
    resultHandlers.set("INTENT_REGENERATE_DONE", (msg) => {
      const targetEl = inflightRequests.get(msg.requestId);
      const cb = inflightRequestCallbacks.get(msg.requestId);
      inflightRequests.delete(msg.requestId);
      inflightRequestCallbacks.delete(msg.requestId);
      inflightSnapshots.delete(msg.requestId);

      if (targetEl && targetEl.isConnected && msg.html) {
        try {
          const safeFrag = sanitizeGeneratedHtml(msg.html);
          targetEl.dataset.mytakeOriginalHtml = targetEl.dataset.mytakeOriginalHtml
            || targetEl.innerHTML;
          targetEl.replaceChildren(safeFrag);
          if (cb) {
            if (cb.onSuccess) cb.onSuccess();
          }
        } catch (e) {
          console.warn(`${TAG} Failed to apply regenerated HTML:`, e);
          if (cb) {
            if (cb.onError) cb.onError("Failed to apply result");
          }
        }
      } else if (cb) {
        if (cb.onError) cb.onError("Target no longer on page");
      }
    });

    // 4. Pattern Handler (INTENT_PATTERN_DONE)
    resultHandlers.set("INTENT_PATTERN_DONE", (msg) => {
      const targetEl = inflightRequests.get(msg.requestId);
      const cb = inflightRequestCallbacks.get(msg.requestId);
      inflightRequests.delete(msg.requestId);
      inflightRequestCallbacks.delete(msg.requestId);
      inflightSnapshots.delete(msg.requestId);

      if (targetEl && targetEl.isConnected && msg.matches) {
        try {
          let parsed;
          try {
            parsed = JSON.parse(msg.matches);
          } catch (e) {
            parsed = { matches: [] };
          }
          const matchCount = applyPatternMatches(targetEl, parsed.matches || []);
          if (cb) {
            if (matchCount > 0) {
              if (cb.onSuccess) cb.onSuccess();
            } else if (cb.onError) {
              cb.onError("No matching text found");
            }
          }
        } catch (e) {
          console.warn(`${TAG} Failed to apply pattern matches:`, e);
          if (cb) {
            if (cb.onError) cb.onError("Failed to apply result");
          }
        }
      } else if (cb) {
        if (cb.onError) cb.onError("Target no longer on page");
      }
    });

    // 5. Tool Handler (INTENT_TOOL_DONE)
    resultHandlers.set("INTENT_TOOL_DONE", (msg) => {
      const cb = inflightRequestCallbacks.get(msg.requestId);
      inflightRequests.delete(msg.requestId);
      inflightRequestCallbacks.delete(msg.requestId);
      inflightSnapshots.delete(msg.requestId);
      if (cb) {
        if (cb.onSuccess) cb.onSuccess();
      }
    });

    // 6. Structural Edit Handler (INTENT_STRUCTURAL_DONE)
    resultHandlers.set("INTENT_STRUCTURAL_DONE", (msg) => {
      const targetEl = inflightRequests.get(msg.requestId);
      const childTags = inflightSnapshots.get(msg.requestId);
      const cb = inflightRequestCallbacks.get(msg.requestId);
      inflightRequests.delete(msg.requestId);
      inflightRequestCallbacks.delete(msg.requestId);
      inflightSnapshots.delete(msg.requestId);

      if (!targetEl || !targetEl.isConnected) {
        console.warn(`${TAG} Structural operation failed: Target element not connected or present`);
        if (cb) {
          if (cb.onError) cb.onError("Target no longer on page");
        }
        return;
      }

      const { structuralOp, targetIndex, insertPosition, html } = msg;

      // Resolve the actual node to operate on
      let resolvedNode = null;
      if (targetIndex === null || targetIndex === undefined) {
        resolvedNode = targetEl;
      } else {
        if (targetEl.children && targetIndex >= 0 && targetIndex < targetEl.children.length) {
          resolvedNode = targetEl.children[targetIndex];
        }
      }

      // Re-verify it is still present and connected before acting
      if (!resolvedNode || !resolvedNode.isConnected) {
        console.warn(`${TAG} Structural operation failed: Resolved node not connected or present`);
        if (cb) {
          if (cb.onError) cb.onError("Target child node no longer present or connected");
        }
        return;
      }

      // Re-check tag name matches what was in the snapshot at request time
      if (targetIndex !== null && targetIndex !== undefined && childTags) {
        const expectedTag = childTags[targetIndex];
        const actualTag = resolvedNode.tagName.toLowerCase();
        if (expectedTag && actualTag !== expectedTag) {
          console.warn(`${TAG} Structural operation failed: Tag mismatch (expected ${expectedTag}, got ${actualTag})`);
          if (cb) {
            if (cb.onError) cb.onError("Target element structure changed since request");
          }
          return;
        }
      }

      try {
        if (structuralOp === "duplicate") {
          const clone = resolvedNode.cloneNode(true);
          // Strip id attributes and MyTake state classes from clone root and subtree
          const stateClasses = ["mytake-target-locked", "mytake-target-processing", "mytake-target-done", "mytake-target-error"];
          const cleanNode = (el) => {
            el.removeAttribute("id");
            stateClasses.forEach(cls => el.classList.remove(cls));
          };
          cleanNode(clone);
          clone.querySelectorAll("[id], " + stateClasses.map(cls => "." + cls).join(", ")).forEach(cleanNode);

          // Insert adjacent to original
          resolvedNode.parentNode.insertBefore(clone, resolvedNode.nextSibling);

          if (cb) {
            if (cb.onSuccess) cb.onSuccess();
          }
        } else if (structuralOp === "remove") {
          // If resolving to lockedTargetEl itself, clean up UI state in correct order
          if (resolvedNode === lockedTargetEl) {
            if (isCtxChatActive) resetCtxChat();
            hideContextualPopup();
            lockedTargetEl = null;
          }

          // Push onto capped undo stack
          undoStack.push({
            op: "remove",
            node: resolvedNode,
            parent: resolvedNode.parentNode,
            nextSibling: resolvedNode.nextSibling
          });

          resolvedNode.remove();

          if (cb) {
            if (cb.onSuccess) cb.onSuccess();
          }
        } else if (structuralOp === "insert") {
          if (!html) {
            throw new Error("No HTML generated for insert operation");
          }

          const safeFrag = sanitizeGeneratedHtml(html);
          
          // Enforce a cap on the number of top-level generated nodes
          if (safeFrag.children.length > 10) {
            throw new Error("Too many top-level nodes in generated HTML fragment (max: 10)");
          }

          const insertedNodes = Array.from(safeFrag.childNodes);

          // Insert relative to resolvedNode
          if (insertPosition === "before") {
            resolvedNode.parentNode.insertBefore(safeFrag, resolvedNode);
          } else if (insertPosition === "after") {
            resolvedNode.parentNode.insertBefore(safeFrag, resolvedNode.nextSibling);
          } else if (insertPosition === "append") {
            resolvedNode.appendChild(safeFrag);
          } else if (insertPosition === "prepend") {
            resolvedNode.insertBefore(safeFrag, resolvedNode.firstChild);
          } else {
            throw new Error("Unknown insert position: " + insertPosition);
          }

          // Push to undo stack
          undoStack.push({
            op: "insert",
            nodes: insertedNodes,
            parent: resolvedNode.parentNode || resolvedNode
          });

          if (cb) {
            if (cb.onSuccess) cb.onSuccess();
          }
        } else {
          throw new Error("Unknown structural operation: " + structuralOp);
        }
      } catch (e) {
        console.warn(`${TAG} Failed to execute structural edit:`, e);
        if (cb) {
          if (cb.onError) cb.onError(e.message || "Failed to execute structural edit");
        }
      }
    });

    // 7. Fail Handler (INTENT_FAIL)
    resultHandlers.set("INTENT_FAIL", (msg) => {
      const cb = inflightRequestCallbacks.get(msg.requestId);
      inflightRequests.delete(msg.requestId);
      inflightRequestCallbacks.delete(msg.requestId);
      inflightSnapshots.delete(msg.requestId);
      if (cb) {
        if (cb.onError) cb.onError(msg.error);
      }
    });

    resultHandlers.set("INTENT_PHASE_UPDATE", (msg) => {
      const targetEl = inflightRequests.get(msg.requestId);
      if (targetEl && phaseToast) {
        const rect = targetEl.getBoundingClientRect();
        phaseToast.style.display = "block";
        phaseToast.style.background = "rgba(0,0,0,0.85)";
        phaseToast.style.pointerEvents = "none";
        delete phaseToast.dataset.warning;
        phaseToast.innerHTML = `${msg.phase} <span style="font-weight:400; opacity:0.8; margin-left:6px;">${msg.detail || ""}</span>`;
        phaseToast.style.left = `${rect.left}px`;
        phaseToast.style.top = `${rect.top}px`;
      }
    });

    resultHandlers.set("INTENT_PHASE_CLEANUP", (msg) => {
      if (phaseToast && phaseToast.dataset.warning !== "true") {
        phaseToast.style.display = "none";
      }
    });

    resultHandlers.set("INTENT_NEEDS_CONFIRMATION", (msg) => {
      const targetEl = inflightRequests.get(msg.requestId);
      if (targetEl && phaseToast) {
        const rect = targetEl.getBoundingClientRect();
        phaseToast.style.display = "block";
        phaseToast.style.background = "#b91c1c";
        phaseToast.style.pointerEvents = "auto";
        phaseToast.dataset.warning = "true";
        phaseToast.innerHTML = `
          <div style="display:flex; align-items:center; gap:8px;">
            <span>⚠️ Judge flagged this ${msg.structuralOp || 'change'}</span>
            <button id="mt-toast-confirm" style="background:#fff; color:#b91c1c; border:none; border-radius:4px; padding:2px 6px; cursor:pointer; font-weight:bold;">Apply Anyway</button>
            <button id="mt-toast-cancel" style="background:transparent; color:#fff; border:1px solid rgba(255,255,255,0.5); border-radius:4px; padding:2px 6px; cursor:pointer;">Cancel</button>
          </div>
          <div style="font-weight:400; font-size:10px; opacity:0.9; margin-top:4px; white-space:normal; max-width:250px;">${msg.reason}</div>
        `;
        phaseToast.style.left = `${rect.left}px`;
        phaseToast.style.top = `${rect.top}px`;

        const applyBtn = phaseToast.querySelector("#mt-toast-confirm");
        const cancelBtn = phaseToast.querySelector("#mt-toast-cancel");

        const cleanup = () => {
          phaseToast.style.display = "none";
          delete phaseToast.dataset.warning;
          inflightRequests.delete(msg.requestId);
          inflightRequestCallbacks.delete(msg.requestId);
          inflightSnapshots.delete(msg.requestId);
          if (targetEl) targetEl.classList.remove("mytake-target-processing");
        };

        applyBtn.addEventListener("click", () => {
          msg.type = "INTENT_STRUCTURAL_DONE";
          resultHandlers.get(msg.type)(msg); // manually route it to the done handler
          cleanup();
        });

        cancelBtn.addEventListener("click", cleanup);
      }
    });

    function handleJudgeWarning(msg) {
      if (msg.judgeWarning && phaseToast) {
        const targetEl = inflightRequests.get(msg.requestId);
        if (targetEl) {
          const rect = targetEl.getBoundingClientRect();
          phaseToast.style.display = "block";
          phaseToast.style.background = "#ea580c"; // orange for non-destructive warning
          phaseToast.style.pointerEvents = "auto";
          phaseToast.dataset.warning = "true";
          phaseToast.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
              <span>⚠️ AI applied this, but...</span>
              <button id="mt-toast-dismiss" style="background:transparent; color:#fff; border:none; cursor:pointer; font-size:14px; padding:0;">✕</button>
            </div>
            <div style="font-weight:400; font-size:10px; opacity:0.9; margin-top:4px; white-space:normal; max-width:250px;">${msg.judgeWarning}</div>
          `;
          phaseToast.style.left = `${rect.left}px`;
          phaseToast.style.top = `${rect.top}px`;
          
          phaseToast.querySelector("#mt-toast-dismiss").addEventListener("click", () => {
            phaseToast.style.display = "none";
            delete phaseToast.dataset.warning;
          });
        }
      }
    }

    // Dispatch message if it's handled by resultHandlers
    if (resultHandlers.has(msg.type)) {
      if (msg.type.endsWith("_DONE") && msg.judgeWarning) {
        handleJudgeWarning(msg);
      }
      resultHandlers.get(msg.type)(msg);
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
        nodeState.set(entry.node, "COMPLETED");
      }

      broadcastProgress();
      processNextCommandBatch();
    }

    if (msg.type === "COMMAND_FAIL") {
      const entry = commandInflightRequests.get(msg.requestId);
      commandInflightRequests.delete(msg.requestId);

      if (entry && entry.node) {
        nodeState.delete(entry.node);
        if (entry.node.isConnected && entry.originalText) {
          entry.node._mytakeRephrased = entry.originalText;
          entry.node.textContent = entry.originalText;
          entry.node._mytakeRephrased = undefined;
        }
      }

      broadcastProgress();
      processNextCommandBatch();
    }

    // ── Ask AI responses (from content-main.js via window.postMessage) ────────
    if (msg.type === "ASK_PAGE_STREAM") {
      console.log("[MyTake] Received ASK_PAGE_STREAM", msg.text?.length);
      updateAskMessage(msg.requestId, msg.text, false, false);
    }
    if (msg.type === "ASK_PAGE_DONE") {
      console.log("[MyTake] Received ASK_PAGE_DONE", msg.text?.length);
      updateAskMessage(msg.requestId, msg.text, true, false);
    }
    if (msg.type === "ASK_PAGE_FAIL") {
      console.log("[MyTake] Received ASK_PAGE_FAIL", msg.error);
      updateAskMessage(msg.requestId, "Error: " + msg.error, true, true);
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
    const state = nodeState.get(node);
    if (state === "PROCESSING" || state === "COMPLETED" || state === "QUEUED") return;

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
      nodeState.set(node, "COMPLETED");
      return;
    }

    nodeState.set(node, "QUEUED");
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

    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
      return; // Token bucket limit reached
    }

    const availableSlots = MAX_CONCURRENT_REQUESTS - activeRequests;
    const batch = [...pendingNodes].slice(0, availableSlots);
    for (const n of batch) pendingNodes.delete(n);
    broadcastProgress();

    if (batch.length === 0) {
      if (pendingNodes.size === 0 && activeRequests === 0) {
         manualRunning = false;
      }
      return;
    }

    for (const node of batch) {
      if (!node.isConnected) continue;
      const state = nodeState.get(node);
      if (state === "PROCESSING" || state === "COMPLETED") continue;

      const original = node._mytakeOriginal;
      if (!original || original.length < MIN_CHARS) continue;

      const requestId = crypto.randomUUID();
      inflightRequests.set(requestId, node);
      nodeState.set(node, "PROCESSING");
      activeRequests++;
      postToMain("REPHRASE_REQUEST", { requestId, text: original });
    }

    // Automatically check if we can process more right away
    if (pendingNodes.size > 0 && manualRunning && activeRequests < MAX_CONCURRENT_REQUESTS) {
      processBatch();
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
    activeRequests = 0;
    commandQueue = [];
    commandRunning = false;
    manualRunning = false;
    if (batchTimer) clearTimeout(batchTimer);

    restoreOriginals();
    

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

      const requestId = crypto.randomUUID();
      commandInflightRequests.set(requestId, { node, originalText: original });
      nodeState.set(node, "PROCESSING");
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

  // ── Helpers for TRANSFORM_AND_REPLACE / text_pattern jobs ──────────────────

  // Strips anything that could execute code from model-generated HTML before
  // it's ever inserted into the page: script/style/iframe/object/embed tags,
  // event-handler attributes (onclick, onerror, ...), and javascript: URLs.
  function sanitizeGeneratedHtml(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const DISALLOWED_TAGS = new Set([
      "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM",
    ]);

    const walk = (root) => {
      const toRemove = [];
      for (const el of root.querySelectorAll("*")) {
        if (DISALLOWED_TAGS.has(el.tagName)) {
          toRemove.push(el);
          continue;
        }
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          const value = attr.value || "";
          if (name.startsWith("on")) {
            el.removeAttribute(attr.name);
          } else if (
            (name === "href" || name === "src") &&
            value.trim().toLowerCase().startsWith("javascript:")
          ) {
            el.removeAttribute(attr.name);
          }
        }
      }
      toRemove.forEach((el) => el.remove());
    };

    walk(doc.body);
    
    const frag = document.createDocumentFragment();
    while (doc.body.firstChild) {
      frag.appendChild(doc.body.firstChild);
    }
    return frag;
  }

  // Applies substring-level matches (from the text_pattern job) to every
  // qualifying text node inside targetEl. Each match's "original" substring
  // is located via exact string search; "replacement" swaps the text and
  // "style" (if present) wraps that substring in a <span> carrying just
  // those CSS properties — so the rest of the node is left untouched.
  // Returns the number of matches actually applied.
  function applyPatternMatches(targetEl, matches) {
    if (!Array.isArray(matches) || matches.length === 0) return 0;
    let appliedCount = 0;

    const validMatches = matches.filter(m => m && m.original);

    let madeChanges = true;
    while (madeChanges) {
      madeChanges = false;
      const walker = document.createTreeWalker(targetEl, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (n._mytakeProcessed) return NodeFilter.FILTER_REJECT;
          if (!n.parentElement) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(n.parentElement.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
          if (isExcludedAncestry(n)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      let node;
      while ((node = walker.nextNode())) {
        let appliedToThisNode = false;
        for (const match of validMatches) {
          const original = match.original;
          const idx = node.textContent.indexOf(original);
          if (idx !== -1) {
            const before = node.textContent.slice(0, idx);
            const after = node.textContent.slice(idx + original.length);
            const parent = node.parentNode;
            
            const frag = document.createDocumentFragment();
            if (before) frag.appendChild(document.createTextNode(before));
            
            const replacement = typeof match.replacement === "string" ? match.replacement : original;
            const style = match.style && typeof match.style === "object" ? match.style : null;
            
            let insertedNode;
            if (style) {
              const span = document.createElement("span");
              span.textContent = replacement;
              for (const key in style) {
                const kebabKey = key.replace(/([A-Z])/g, "-$1").toLowerCase();
                span.style.setProperty(kebabKey, style[key]);
              }
              insertedNode = span;
              frag.appendChild(span);
            } else {
              const txt = document.createTextNode(replacement);
              txt._mytakeProcessed = true;
              insertedNode = txt;
              frag.appendChild(txt);
            }
            
            if (after) frag.appendChild(document.createTextNode(after));
            parent.replaceChild(frag, node);
            
            // Mark children of span as processed to avoid infinite loops
            if (style) {
              const spanWalker = document.createTreeWalker(insertedNode, NodeFilter.SHOW_TEXT);
              let childText;
              while ((childText = spanWalker.nextNode())) {
                childText._mytakeProcessed = true;
              }
            }
            
            appliedCount++;
            madeChanges = true;
            appliedToThisNode = true;
            break; // Break matches loop, restart walker
          }
        }
        if (appliedToThisNode) break; // Break walker loop, restart
      }
    }
    return appliedCount;
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
        const state = nodeState.get(target);
        if (state === "COMPLETED" || state === "PROCESSING") continue;
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
    activeRequests = 0;
    commandQueue = [];
    commandRunning = false;
    if (batchTimer) clearTimeout(batchTimer);

    restoreOriginals();
    

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
          nodeState.set(n, "COMPLETED");
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
  let isCtxChatActive = false;
  let isAskGenerating = false;
  let currentAskRequestId = null;
  let targetHoveredEl = null;
  let targetPicker = null;
  let pickerFrozen = false;
  const targetChatHistory = new WeakMap();

  let chicMenu, chicFab, chicInput, chicTargetBtn, chicMoods;
  let currentChicPrompt = "mood:simple"; // Default
  
  let CHIC_MOODS = [
    { id: "original", name: "Original", color: "#94a3b8" },
    { id: "explain", name: "Explain", color: "#fde047" },
    { id: "donald", name: "Donald", color: "#fdba74" },
    { id: "cherry", name: "Cherry", color: "#fda4af" },
    { id: "honest", name: "Honest", color: "#7dd3fc" },
    { id: "brutally-honest", name: "Brutal", color: "#fca5a5" },
    { id: "academic", name: "Academic", color: "#a5b4fc" },
    { id: "casual", name: "Casual", color: "#6ee7b7" },
    { id: "poetic", name: "Poetic", color: "#f0abfc" },
    { id: "simple", name: "Simple", color: "#c4b5fd" }
  ];
  try {
    chrome.storage.local.get(["mtCustomMoods", "hideFloatingBtn"], (res) => {
      if (res && res.mtCustomMoods) {
        CHIC_MOODS.push(...res.mtCustomMoods);
        // If UI already injected, rebuild carousel
        if (typeof rebuildCarousel === "function") rebuildCarousel();
      }
      if (chicFab) {
        chicFab.style.display = (res && res.hideFloatingBtn) ? "none" : "";
      }
    });
  } catch(e) {}

  let contextualPopup = null;
  let phaseToast = null;
  let lockedTargetEl = null;
  let mytakeShadowHost = null;
  let mytakeShadowRoot = null;

  function injectChicUI() {
    if (document.getElementById("mytake-shadow-host")) return;
    
    mytakeShadowHost = document.createElement("div");
    mytakeShadowHost.id = "mytake-shadow-host";
    mytakeShadowHost.style.cssText = "position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; overflow: visible;";
    document.body.appendChild(mytakeShadowHost);
    mytakeShadowRoot = mytakeShadowHost.attachShadow({ mode: "open" });
    
    // Inject styles immediately to prevent FOUC
    injectTargetStyles();
    
    // Static Minimal FAB
    chicFab = document.createElement("div");
    chicFab.id = "mytake-chic-fab";
    chicFab.className = "mytake-fab minimal";
    chicFab.style.display = "none"; // Hide initially until settings loaded
    chrome.storage.local.get(["hideFloatingBtn"], (res) => {
      chicFab.style.display = res.hideFloatingBtn ? "none" : "";
    });
    chicFab.innerHTML = `<svg viewBox="-60 -60 120 130" width="28" height="28" style="pointer-events: none;">
      <path d="M0 0 C -22 -8,-28 -34,-10 -38 C -2 -40,0 -32,0 -26 C 0 -32,2 -40,10 -38 C 28 -34,22 -8,0 0Z" fill="currentColor"/>
      <g style="transform:rotate(120deg)"><path d="M0 0 C -22 -8,-28 -34,-10 -38 C -2 -40,0 -32,0 -26 C 0 -32,2 -40,10 -38 C 28 -34,22 -8,0 0Z" fill="currentColor"/></g>
      <g style="transform:rotate(240deg)"><path d="M0 0 C -22 -8,-28 -34,-10 -38 C -2 -40,0 -32,0 -26 C 0 -32,2 -40,10 -38 C 28 -34,22 -8,0 0Z" fill="currentColor"/></g>
    </svg>`;
    
    // Main Panel matching original popup design
        const carouselItems = CHIC_MOODS.map((m, i) =>
      `<div class="mt-carousel-item${m.id === 'simple' ? ' selected' : ''}" data-mood="${m.id}" data-color="${m.color}">
         <span class="mt-item-swatch" style="background:${m.color}"></span>
         <span class="mt-item-label">${escapeHtml(m.name)}</span>
         ${m.id.startsWith("custom_") ? `<button class="mt-delete-mood-btn" data-delete="${m.id}" style="position:absolute; top:-4px; right:-4px; background:rgba(0,0,0,0.5); color:#fff; border:none; border-radius:50%; width:16px; height:16px; font-size:10px; cursor:pointer; display:none;">✕</button>` : ''}
       </div>`
    ).join("") + `
       <div class="mt-carousel-item" id="mt-add-custom" data-mood="custom" data-color="#444">
         <span class="mt-item-swatch" style="background:#444">+</span>
         <span class="mt-item-label">Custom</span>
       </div>
    `;

    chicMenu = document.createElement("div");
    chicMenu.className = "mytake-main-panel";
    chicMenu.innerHTML = `
      <div class="mt-ambient" id="mt-ambient"></div>
      <button class="mt-theme-toggle" id="mt-theme-toggle" title="Toggle light/dark mode">
        <svg class="mt-theme-icon-sun" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        <svg class="mt-theme-icon-moon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>

      <div class="mt-globe-container">
        <div class="mt-globe-ring">
          <svg class="mt-clover" viewBox="-60 -60 120 130">
            <defs>
              <radialGradient id="mtLeafGrad" cx="50%" cy="38%" r="65%">
                <stop offset="0%" stop-color="#fff" id="mtGradStop1" />
                <stop offset="100%" stop-color="#c4b5fd" id="mtGradStop2" />
              </radialGradient>
            </defs>
            <path d="M0 8 Q 6 30 2 60" stroke="#888" stroke-width="4" stroke-linecap="round" fill="none"/>
            <g><path d="M0 0 C -22 -8,-28 -34,-10 -38 C -2 -40,0 -32,0 -26 C 0 -32,2 -40,10 -38 C 28 -34,22 -8,0 0Z" fill="url(#mtLeafGrad)"/></g>
            <g style="transform:rotate(120deg)"><path d="M0 0 C -22 -8,-28 -34,-10 -38 C -2 -40,0 -32,0 -26 C 0 -32,2 -40,10 -38 C 28 -34,22 -8,0 0Z" fill="url(#mtLeafGrad)"/></g>
            <g style="transform:rotate(240deg)"><path d="M0 0 C -22 -8,-28 -34,-10 -38 C -2 -40,0 -32,0 -26 C 0 -32,2 -40,10 -38 C 28 -34,22 -8,0 0Z" fill="url(#mtLeafGrad)"/></g>
            <circle cx="0" cy="0" r="3.5" fill="#fff" />
          </svg>
        </div>
      </div>
      <div class="mt-mood-meta">
        <div class="mt-globe-label" id="mt-globe-label">Simple</div>
      </div>
      <div class="mt-carousel-viewport">
                <div class="mt-carousel-track" id="mt-carousel-track">${carouselItems}</div>
      </div>
      <div class="mt-custom-input-container" id="mt-custom-input-container" style="display: none; margin-top: 12px; width: 100%; padding: 0 16px; box-sizing: border-box;">
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <input type="text" id="mt-custom-name" placeholder="Mood Name (e.g. Sarcastic)" class="mt-custom-input-field" autocomplete="off" />
          <input type="text" id="mt-custom-input" placeholder="Prompt (e.g. Make it sound sarcastic)" class="mt-custom-input-field" autocomplete="off" />
          <div style="display: flex; justify-content: flex-end; gap: 8px;">
            <button id="mt-custom-cancel-btn" style="background:transparent; color:inherit; border:1px solid rgba(255,255,255,0.2); padding:6px 12px; border-radius:6px; font-size:12px; font-weight:700; cursor:pointer;">Cancel</button>
            <button id="mt-custom-apply-btn" style="background:#fff; color:#000; border:none; padding:6px 12px; border-radius:6px; font-size:12px; font-weight:700; cursor:pointer;">Add & Apply</button>
          </div>
        </div>
      </div>

      <div id="mt-ask-panel" style="display: none; flex-direction: column; width: 100%; flex: 1 1 0; box-sizing: border-box; padding: 0 16px; margin-top: 8px; overflow: hidden; min-height: 0;">
         <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-shrink: 0;">
            <button id="mt-ask-back-btn" class="mt-ask-btn-icon" title="Back to Moods">
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
            </button>
            <span style="font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.5);">Ask AI</span>
            <div style="width: 32px;"></div>
         </div>
         <div id="mt-ask-messages" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; padding-right: 0; scrollbar-width: none;"></div>
         <div id="mt-active-files" style="display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;"></div>
      </div>

      <div id="mt-main-actions" style="display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 16px; margin-bottom: 16px; z-index: 1; position: relative;">
        <button class="mt-action-btn" id="mt-target-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>
          Target
        </button>
        <button class="mt-action-btn" id="mt-ask-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
          Ask
        </button>
        <button class="mt-action-btn" id="mt-resume-chat-btn" style="display: none; background: rgba(167, 139, 250, 0.2); border-color: rgba(167, 139, 250, 0.5);">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
          Resume Target Chat
        </button>
      </div>
      
      <div style="position: relative; display: flex; gap: 8px; align-items: center; padding: 0 16px; margin-bottom: 16px; width: 100%; box-sizing: border-box; flex-shrink: 0;">
        <div id="mt-slash-menu" style="display: none; position: absolute; bottom: 100%; left: 0; margin-bottom: 8px; width: 200px; max-height: 150px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; overflow-y: auto; z-index: 10; box-shadow: 0 4px 12px rgba(0,0,0,0.5); flex-direction: column; scrollbar-width: none;"></div>
        <button id="mt-ask-attach-btn" class="mt-ask-btn-icon" title="Attach a file" style="opacity: 0.6; padding: 4px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
        </button>
        <input type="file" id="mt-ask-file-input" style="display: none;" accept=".txt,.md,.csv,.js,.py,.html,.css,.json,.pdf" multiple />
        <input type="text" id="mt-ask-input" placeholder="Ask about this page or type / to attach..." style="flex: 1; margin: 0; border: none; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.2); border-radius: 0; background: transparent; font-size: 12px; outline: none; transition: border-color 0.2s;" autocomplete="off" />
        <button id="mt-ask-send" class="mt-ask-btn-icon" style="background: #fff; color: #111; border-radius: 50%; padding: 6px; flex-shrink: 0;">
          <svg id="mt-send-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          <svg id="mt-stop-icon" style="display: none;" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12"></rect></svg>
        </button>
      </div>
      
      <div class="mt-disclaimer-overlay" id="mt-disclaimer-overlay">
        <div class="mt-disclaimer-content">
          <div class="mt-disclaimer-title">Chrome AI Unavailable</div>
          <ul class="mt-disclaimer-steps">
            <li>Go to <code>chrome://flags/#prompt-api-for-gemini-nano</code> and set to <b>Enabled</b>.</li>
            <li>Go to <code>chrome://flags/#optimization-guide-on-device-model</code> and set to <b>Enabled BypassPerfRequirement</b>.</li>
            <li>Relaunch Chrome.</li>
          </ul>
          <div class="mt-disclaimer-detail">If the model is still downloading, wait a moment and try again.</div>
          <button class="mt-btn-check" id="mt-btn-recheck">Check Again</button>
        </div>
      </div>
    `;
    
    mytakeShadowRoot.appendChild(chicFab);
    mytakeShadowRoot.appendChild(chicMenu);


    
    chicMenu.querySelector("#mt-btn-recheck")?.addEventListener("click", () => {
      try { chrome.runtime.sendMessage({ type: "TRIGGER_MODEL_UPDATE" }).catch(()=>{}); } catch (_) {}
      setTimeout(() => location.reload(), 300);
    });

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        if (chicMenu.classList.contains("open")) {
          chicMenu.classList.remove("open");
        } else {
          chicMenu.classList.add("open");
          chicMenu.scrollTop = 0;
          setTimeout(() => chicMenu.querySelector("#mt-ask-input").focus({ preventScroll: true }), 50);
        }
      }
    });
    
    // Contextual Popup for Target Mode
    contextualPopup = document.createElement("div");
    contextualPopup.className = "mytake-contextual-popup";
    contextualPopup.innerHTML = `
      <div class="ctx-header">Select Mood or Custom Prompt <span class="ctx-close" id="ctx-close">✕</span></div>
      <div class="ctx-moods">${CHIC_MOODS.map(m => `<button class="ctx-mood-btn" data-mood="${m.id}" style="border-bottom: 2px solid ${m.color}">${m.name}</button>`).join("")}</div>
      <div id="ctx-ask-messages" style="display: none; max-height: 400px; overflow-y: auto; flex-direction: column; gap: 8px; font-size: 11px; margin-top: 4px; padding-right: 4px; scrollbar-width: none;"></div>
      <div class="ctx-custom">
        <input type="text" id="ctx-custom-input" placeholder="Ask about this element..." autocomplete="off">
        <button id="ctx-apply-btn">Apply</button>
        <button id="ctx-ask-btn">Ask AI</button>
      </div>
    `;
    mytakeShadowRoot.appendChild(contextualPopup);

    phaseToast = document.createElement("div");
    phaseToast.className = "mytake-phase-toast";
    phaseToast.style.cssText = "display: none; position: absolute; background: rgba(0,0,0,0.85); color: #fff; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; pointer-events: none; z-index: 2147483647; white-space: nowrap; box-shadow: 0 4px 12px rgba(0,0,0,0.5); transform: translateY(-100%); margin-top: -8px;";
    mytakeShadowRoot.appendChild(phaseToast);

    const items = chicMenu.querySelectorAll(".mt-carousel-item");
    const label = chicMenu.querySelector("#mt-globe-label");
    const stop2 = chicMenu.querySelector("#mtGradStop2");
    const ambient = chicMenu.querySelector("#mt-ambient");
    const btnTarget = chicMenu.querySelector("#mt-target-btn");

            function setMoodUI(item) {
      if (!item) return;
      chicMenu.querySelectorAll(".mt-carousel-item").forEach(i => i.classList.remove("selected"));
      const customBtn = chicMenu.querySelector("#mt-add-custom");
      if(customBtn) customBtn.classList.remove("selected");
      
      item.classList.add("selected");
      label.innerText = item.querySelector(".mt-item-label").innerText;
      
      const c = item.dataset.color;
      stop2.setAttribute("stop-color", c);
      
      document.documentElement.style.setProperty("--mt-active-color", c);
      
      // Flood the ambient background
      ambient.style.background = `radial-gradient(60% 60% at 50% 30%, color-mix(in srgb, var(--mt-active-color) 60%, transparent), transparent 70%)`;
      chicMenu.style.backgroundColor = `color-mix(in srgb, rgba(20,20,20,0.95) 85%, var(--mt-active-color))`;
      
      const customContainer = chicMenu.querySelector("#mt-custom-input-container");
      const customInput = chicMenu.querySelector("#mt-custom-input");

      if (item.dataset.mood === "custom") {
        customContainer.style.display = "block";
        const customName = chicMenu.querySelector("#mt-custom-name");
        customInput.focus({ preventScroll: true });

        const doAdd = () => {
          const nameVal = customName.value.trim() || "Custom";
          const promptVal = customInput.value.trim();
          if (promptVal) {
             const newMood = {
                id: "custom_" + Date.now(),
                name: nameVal,
                color: "#" + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0'),
                customPrompt: promptVal
             };
             CHIC_MOODS.push(newMood);
             chrome.storage.local.set({ mtCustomMoods: CHIC_MOODS.filter(m => m.id.startsWith("custom_")) });
             rebuildCarousel();
             const track = chicMenu.querySelector("#mt-carousel-track");
             const newItem = track.querySelector(`.mt-carousel-item[data-mood="${newMood.id}"]`);
             if (newItem) setMoodUI(newItem);
             resetAndReinit(newMood.id, promptVal);
          }
        };

        const handleKey = (e) => {
            e.stopPropagation();
            if (e.key === "Enter") doAdd();
        };
        customInput.onkeydown = handleKey;
        customName.onkeydown = handleKey;
        const stopProp = (e) => e.stopPropagation();
        customInput.onkeyup = stopProp;
        customInput.onkeypress = stopProp;
        customName.onkeyup = stopProp;
        customName.onkeypress = stopProp;

        const applyBtn = chicMenu.querySelector("#mt-custom-apply-btn");
        if (applyBtn) applyBtn.onclick = doAdd;
        
        const cancelBtn = chicMenu.querySelector("#mt-custom-cancel-btn");
        if (cancelBtn) {
           cancelBtn.onclick = () => {
              const defaultItem = chicMenu.querySelector('.mt-carousel-item[data-mood="simple"]') || chicMenu.querySelector('.mt-carousel-item[data-mood="original"]');
              if (defaultItem) {
                 setMoodUI(defaultItem);
                 resetAndReinit(defaultItem.dataset.mood);
              }
           };
        }
      } else {
        customContainer.style.display = "none";
        currentChicPrompt = "mood:" + item.dataset.mood;
      }
    }

    // Initial UI state
    setMoodUI(chicMenu.querySelector(".mt-carousel-item.selected"));

    window.rebuildCarousel = function() {
        const track = chicMenu.querySelector("#mt-carousel-track");
        if(!track) return;
        
        let currentMoodId = "simple";
        const selectedEl = chicMenu.querySelector(".mt-carousel-item.selected");
        if (selectedEl) currentMoodId = selectedEl.dataset.mood;

        const html = CHIC_MOODS.map((m) =>
          `<div class="mt-carousel-item${m.id === currentMoodId ? ' selected' : ''}" data-mood="${m.id}" data-color="${m.color}">
             <span class="mt-item-swatch" style="background:${m.color}"></span>
             <span class="mt-item-label">${escapeHtml(m.name)}</span>
             ${m.id.startsWith("custom_") ? `<button class="mt-delete-mood-btn" data-delete="${m.id}" style="position:absolute; top:-4px; right:-4px; background:rgba(0,0,0,0.5); color:#fff; border:none; border-radius:50%; width:16px; height:16px; font-size:10px; cursor:pointer; display:none;">✕</button>` : ''}
           </div>`
        ).join("") + `
           <div class="mt-carousel-item${currentMoodId === 'custom' ? ' selected' : ''}" id="mt-add-custom" data-mood="custom" data-color="#444">
             <span class="mt-item-swatch" style="background:#444">+</span>
             <span class="mt-item-label">Custom</span>
           </div>
        `;
        track.innerHTML = html;
        
        // Setup delete buttons
        track.querySelectorAll('.mt-carousel-item').forEach(el => {
          el.addEventListener('mouseenter', () => {
             const del = el.querySelector('.mt-delete-mood-btn');
             if(del) del.style.display = 'block';
          });
          el.addEventListener('mouseleave', () => {
             const del = el.querySelector('.mt-delete-mood-btn');
             if(del) del.style.display = 'none';
          });
        });
        track.querySelectorAll('.mt-delete-mood-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
             e.stopPropagation();
             const delId = btn.dataset.delete;
             CHIC_MOODS = CHIC_MOODS.filter(m => m.id !== delId);
             chrome.storage.local.set({ mtCustomMoods: CHIC_MOODS.filter(m => m.id.startsWith("custom_")) }, () => {
                rebuildCarousel();
                // If deleted mood was active, switch to simple
                const sel = chicMenu.querySelector(".mt-carousel-item.selected");
                if (!sel) {
                   const simple = chicMenu.querySelector('.mt-carousel-item[data-mood="simple"]');
                   if (simple) {
                      setMoodUI(simple);
                      resetAndReinit("simple");
                   }
                }
             });
          });
        });
        const newItems = track.querySelectorAll(".mt-carousel-item");
        newItems.forEach(item => {
          item.addEventListener("click", () => {
             if (!aiReady) return;
             setMoodUI(item);
             if (item.dataset.mood !== "custom") {
                 let promptOverride = CHIC_MOODS.find(m => m.id === item.dataset.mood)?.customPrompt;
                 resetAndReinit(item.dataset.mood, promptOverride);
             }
          });
        });

        
        if (contextualPopup) {
            const ctxMoods = contextualPopup.querySelector(".ctx-moods");
            if (ctxMoods) {
                ctxMoods.innerHTML = CHIC_MOODS.map(m => `<button class="ctx-mood-btn" data-mood="${m.id}" style="border-bottom: 2px solid ${m.color}">${m.name}</button>`).join("");
                ctxMoods.querySelectorAll(".ctx-mood-btn").forEach(btn => {
                    btn.addEventListener("click", () => {
                        if (!aiReady) return;
                        const moodId = btn.dataset.mood;
                        contextualPopup.querySelectorAll(".ctx-mood-btn").forEach(b => b.classList.remove("ctx-mood-selected"));
                        btn.classList.add("ctx-mood-selected");
                        // Auto-apply the mood immediately
                        const el = lockedTargetEl;
                        if (el) {
                            const customV = contextualPopup.querySelector("#ctx-custom-input").value.trim();
                            hideContextualPopup();
                            if (customV) {
                                applyIntentTargetMode(el, customV);
                            } else {
                                applyIntentTargetMode(el, "mood:" + moodId);
                            }
                        }
                    });
                });
            }
        }
    };
    rebuildCarousel();

    chicFab.addEventListener("click", (e) => {
      e.stopPropagation();
      chicMenu.classList.toggle("open");
      if (chicMenu.classList.contains("open")) {
          chicMenu.scrollTop = 0;
          setTimeout(() => chicMenu.querySelector("#mt-ask-input").focus({ preventScroll: true }), 50);
      }
    });

    btnTarget.addEventListener("click", () => {
      if (!aiReady) return;
      chicMenu.classList.remove("open");
      activateTargetMode();
    });

    const resumeChatBtn = chicMenu.querySelector("#mt-resume-chat-btn");
    if (resumeChatBtn) {
        resumeChatBtn.addEventListener("click", () => {
            chicMenu.classList.remove("open");
            contextualPopup.classList.add("open");
            resumeChatBtn.style.display = "none";
        });
    }

    // Ask AI Feature Handlers
    const askPanel = chicMenu.querySelector("#mt-ask-panel");
    const askBtn = chicMenu.querySelector("#mt-ask-btn");
    const askBackBtn = chicMenu.querySelector("#mt-ask-back-btn");
    const carouselView = chicMenu.querySelector(".mt-carousel-viewport");
    const customContainer = chicMenu.querySelector("#mt-custom-input-container");
    const askInput = chicMenu.querySelector("#mt-ask-input");
    const askSend = chicMenu.querySelector("#mt-ask-send");
    const mainActions = chicMenu.querySelector("#mt-main-actions");
    const sendIcon = chicMenu.querySelector("#mt-send-icon");
    const stopIcon = chicMenu.querySelector("#mt-stop-icon");
    
    isAskGenerating = false;
    currentAskRequestId = null;

    const openAskPanel = () => {
        isCtxChatActive = false;
        askPanel.style.display = "flex";
        carouselView.style.display = "none";
        customContainer.style.display = "none";
        mainActions.style.display = "none";
        // hide globe/label to make room in fixed-height panel
        const globe = chicMenu.querySelector(".mt-globe-container");
        const meta = chicMenu.querySelector(".mt-mood-meta");
        if (globe) globe.style.display = "none";
        if (meta) meta.style.display = "none";
        askInput.focus({ preventScroll: true });
    };

    const closeAskPanel = () => {
        askPanel.style.display = "none";
        carouselView.style.display = "block";
        mainActions.style.display = "flex";
        const globe = chicMenu.querySelector(".mt-globe-container");
        const meta = chicMenu.querySelector(".mt-mood-meta");
        if (globe) globe.style.display = "";
        if (meta) meta.style.display = "";
        setMoodUI(chicMenu.querySelector(".mt-carousel-item.selected"));
    };

    askBtn.addEventListener("click", openAskPanel);
    askBackBtn.addEventListener("click", closeAskPanel);

    // Reset generating state when AI completes (updateAskMessage dispatches this)
    chicMenu.addEventListener("ask-done", () => {
      isAskGenerating = false;
    });

    // Wire code copy buttons - defined in outer scope below

    // ── File Attachment & Slash Menu Logic ────────────────────────────────────
    const MAX_CONTEXT_CHARS = 2500;
    let attachedFiles = [];
    let mtSavedFiles = [];

    const fileInput = chicMenu.querySelector("#mt-ask-file-input");
    const attachBtn = chicMenu.querySelector("#mt-ask-attach-btn");
    const activeFilesContainer = chicMenu.querySelector("#mt-active-files");
    const slashMenu = chicMenu.querySelector("#mt-slash-menu");

    chrome.storage.local.get(["mtSavedFiles"], (res) => {
       mtSavedFiles = res.mtSavedFiles || [];
    });

    attachBtn.addEventListener("click", () => fileInput.click());

    function renderActiveFiles() {
        activeFilesContainer.innerHTML = "";
        attachedFiles.forEach((file, index) => {
            const chip = document.createElement("div");
            chip.style.cssText = "display: flex; align-items: center; background: color-mix(in srgb, var(--mt-active-color, #a78bfa) 20%, transparent); color: var(--mt-active-color, #a78bfa); border-radius: 12px; padding: 2px 8px; font-size: 10px; font-weight: 600;";
            chip.innerHTML = `<span style="max-width: 100px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(file.name)}</span>
                              <button style="background: transparent; border: none; color: inherit; margin-left: 4px; cursor: pointer; padding: 0;">✕</button>`;
            chip.querySelector("button").onclick = (e) => {
                e.stopPropagation();
                attachedFiles.splice(index, 1);
                renderActiveFiles();
            };
            activeFilesContainer.appendChild(chip);
        });
    }

    fileInput.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files);
        for (const f of files) {
           let content = "";
           if (f.name.toLowerCase().endsWith(".pdf")) {
              content = await parsePDF(f);
           } else {
              content = await f.text();
           }
           
           const newFile = {
              id: "file-" + Date.now() + Math.random(),
              name: f.name,
              content: content,
              ts: Date.now()
           };
           
           attachedFiles.push(newFile);
           mtSavedFiles.push(newFile);
           if (mtSavedFiles.length > 20) mtSavedFiles = mtSavedFiles.slice(-20);
           chrome.storage.local.set({ mtSavedFiles });
        }
        renderActiveFiles();
        fileInput.value = "";
    });

    async function parsePDF(file) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "INJECT_PDF_JS" }, async (res) => {
                if (chrome.runtime.lastError || !window.pdfjsLib) {
                    resolve("[PDF Parsing Error or PDF.js not loaded]");
                    return;
                }
                
                pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf/pdf.worker.min.js");
                
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
                    let fullText = "";
                    for (let i = 1; i <= pdf.numPages; i++) {
                        const page = await pdf.getPage(i);
                        const content = await page.getTextContent();
                        const strings = content.items.map(item => item.str);
                        fullText += strings.join(" ") + "\\n";
                    }
                    resolve(fullText);
                } catch (e) {
                    resolve("[Failed to read PDF content]");
                }
            });
        });
    }

    let slashSelectedIndex = 0;
    let showingSlashMenu = false;
    let slashQuery = "";
    let filteredSlashFiles = [];

    function renderSlashMenu() {
        slashMenu.innerHTML = "";
        if (filteredSlashFiles.length === 0) {
            slashMenu.innerHTML = `<div class="mt-slash-empty">No saved files</div>`;
            return;
        }
        
        filteredSlashFiles.forEach((file, index) => {
            const item = document.createElement("div");
            item.className = `mt-slash-item ${index === slashSelectedIndex ? "selected" : ""}`;
            item.innerHTML = `
              <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(file.name)}</span>
              <div style="display:flex; gap: 4px;">
                 <button class="mt-slash-download" title="Download" style="background:transparent; border:none; color:var(--mt-active-color, #a78bfa); cursor:pointer;">↓</button>
                 <button class="mt-slash-delete" title="Delete" style="background:transparent; border:none; color:#ef4444; cursor:pointer;">✕</button>
              </div>
            `;
            
            item.addEventListener("click", (e) => {
               if (e.target.closest("button")) return;
               if (!attachedFiles.find(af => af.id === file.id)) {
                   attachedFiles.push(file);
                   renderActiveFiles();
               }
               closeSlashMenu();
               const queryRegex = new RegExp("/" + slashQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$");
               askInput.value = askInput.value.replace(queryRegex, '');
               askInput.focus({ preventScroll: true });
            });
            
            item.querySelector(".mt-slash-download").addEventListener("click", (e) => {
                e.stopPropagation();
                const blob = new Blob([file.content], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = file.name;
                a.click();
                URL.revokeObjectURL(url);
            });
            
            item.querySelector(".mt-slash-delete").addEventListener("click", (e) => {
                e.stopPropagation();
                mtSavedFiles.splice(mtSavedFiles.findIndex(f => f.id === file.id), 1);
                chrome.storage.local.set({ mtSavedFiles });
                attachedFiles = attachedFiles.filter(af => af.id !== file.id);
                filteredSlashFiles = filteredSlashFiles.filter(f => f.id !== file.id);
                renderActiveFiles();
                if (slashSelectedIndex >= filteredSlashFiles.length) slashSelectedIndex = Math.max(0, filteredSlashFiles.length - 1);
                renderSlashMenu();
            });
            
            slashMenu.appendChild(item);
        });
    }

    function closeSlashMenu() {
        showingSlashMenu = false;
        slashMenu.style.display = "none";
    }

    askInput.addEventListener("keydown", (e) => {
        e.stopPropagation(); // Prevent host page shortcuts from triggering (like Google's '/')
        
        if (e.key === "Escape") {
            if (showingSlashMenu) {
                closeSlashMenu();
            } else {
                chicMenu.classList.remove("open");
                askInput.blur();
            }
            e.preventDefault();
            return;
        }

        if (showingSlashMenu) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                slashSelectedIndex = Math.min(filteredSlashFiles.length - 1, slashSelectedIndex + 1);
                renderSlashMenu();
                const selectedEl = slashMenu.querySelector(".mt-slash-item.selected");
                if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
                return;
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                slashSelectedIndex = Math.max(0, slashSelectedIndex - 1);
                renderSlashMenu();
                const selectedEl = slashMenu.querySelector(".mt-slash-item.selected");
                if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
                return;
            } else if (e.key === "Enter") {
                e.preventDefault();
                if (filteredSlashFiles[slashSelectedIndex]) {
                   const file = filteredSlashFiles[slashSelectedIndex];
                   if (!attachedFiles.find(af => af.id === file.id)) {
                       attachedFiles.push(file);
                       renderActiveFiles();
                   }
                }
                closeSlashMenu();
                const queryRegex = new RegExp("/" + slashQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "$");
                askInput.value = askInput.value.replace(queryRegex, '');
                return;
            }
        }
        
        if (e.key === "Enter" && !showingSlashMenu) {
            sendAskMessage();
        }
    });

    askInput.addEventListener("input", (e) => {
        const val = askInput.value;
        if (val.trim().length > 0 && askPanel.style.display === "none") {
            openAskPanel();
        }
        const lastSlashIndex = val.lastIndexOf("/");
        if (lastSlashIndex !== -1 && !val.includes(" ", lastSlashIndex)) {
            showingSlashMenu = true;
            slashQuery = val.substring(lastSlashIndex + 1).toLowerCase();
            filteredSlashFiles = mtSavedFiles.filter(f => f.name.toLowerCase().includes(slashQuery));
            slashSelectedIndex = 0;
            renderSlashMenu();
            slashMenu.style.display = "flex";
        } else if (showingSlashMenu) {
            closeSlashMenu();
        }
    });

    // Prevent host page from intercepting typing in our input
    askInput.addEventListener("keyup", (e) => e.stopPropagation());
    askInput.addEventListener("keypress", (e) => e.stopPropagation());

    // ── End File Attachment Logic ─────────────────────────────────────────────

    const sendAskMessage = (forcedQuestion, forcedContext) => {
        if (!aiReady) {
            // Show a visible message instead of silently failing
            const question = typeof forcedQuestion === 'string' ? forcedQuestion : askInput.value.trim();
            if (question) {
                const reqId = "ask-" + Date.now();
                const messagesContainer = isCtxChatActive ? mytakeShadowRoot.querySelector("#ctx-ask-messages") : chicMenu.querySelector("#mt-ask-messages");
                if (messagesContainer) {
                    const userMsg = document.createElement("div");
                    userMsg.className = "mt-ask-user-msg";
                    userMsg.innerText = question;
                    messagesContainer.appendChild(userMsg);
                }
                updateAskMessage(reqId, "AI session is not ready yet. Please wait a moment and try again.", true, true);
            }
            return;
        }
        if (isAskGenerating) {
            postToMain("ASK_PAGE_ABORT", { requestId: currentAskRequestId });
            isAskGenerating = false;
            if (isCtxChatActive) {
                const btn = mytakeShadowRoot.querySelector("#ctx-ask-btn");
                if (btn) btn.textContent = "Send";
            } else {
                sendIcon.style.display = "block";
                stopIcon.style.display = "none";
            }
            return;
        }

        const question = typeof forcedQuestion === 'string' ? forcedQuestion : askInput.value.trim();
        if (!question) return;
        if (typeof forcedQuestion !== 'string') askInput.value = "";

        const messagesContainer = isCtxChatActive ? mytakeShadowRoot.querySelector("#ctx-ask-messages") : chicMenu.querySelector("#mt-ask-messages");
        if (messagesContainer) {
            const userMsg = document.createElement("div");
            userMsg.className = "mt-ask-user-msg";
            userMsg.innerText = question;
            messagesContainer.appendChild(userMsg);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
        
        const requestId = "ask-" + Date.now();
        currentAskRequestId = requestId;
        
        let cleanContext;
        if (typeof forcedContext === 'string') {
            cleanContext = forcedContext.replace(/[\r\n\s]+/g, " ");
            
            let fileContextLength = 0;
            let filesPayload = [];
            attachedFiles.forEach(f => {
                fileContextLength += f.content.length;
                filesPayload.push({ name: f.name, content: f.content });
            });
            
            if (cleanContext.length + fileContextLength > 50000) {
                 updateAskMessage(requestId, "Target context is extremely large and breached limits, please select a smaller area.", true, true);
                 isAskGenerating = false;
                 return;
            }
            
            // Truncate to available budget
            const availableChars = Math.max(0, MAX_CONTEXT_CHARS - fileContextLength);
            cleanContext = cleanContext.substring(0, availableChars);
        } else {
            const rawText = document.body.innerText || "";
            cleanContext = rawText.replace(/[\r\n\s]+/g, " ");
            
            let fileContextLength = 0;
            let filesPayload = [];
            attachedFiles.forEach(f => {
                fileContextLength += f.content.length;
                filesPayload.push({ name: f.name, content: f.content });
            });
            
            if (cleanContext.length + fileContextLength > 50000) {
                 updateAskMessage(requestId, "Page context is extremely large and breached limits, please select a smaller area using Target.", true, true);
                 isAskGenerating = false;
                 return;
            }
            
            // Truncate to available budget
            const availableChars = Math.max(0, MAX_CONTEXT_CHARS - fileContextLength);
            cleanContext = cleanContext.substring(0, availableChars);
        }
        
        let filesPayload = [];
        attachedFiles.forEach(f => {
            filesPayload.push({ name: f.name, content: f.content });
        });

        isAskGenerating = true;
        if (isCtxChatActive) {
            const btn = mytakeShadowRoot.querySelector("#ctx-ask-btn");
            if (btn) btn.textContent = "Stop";
        } else {
            sendIcon.style.display = "none";
            stopIcon.style.display = "block";
        }
        
        postToMain("ASK_PAGE_REQUEST", { requestId, question, pageContext: cleanContext, attachedFiles: filesPayload });
        console.log(`${TAG} [Diagnostics] Sent payload to AI. Question length: ${question.length}, Context length: ${cleanContext.length}, Files: ${attachedFiles.length}`);
        
        updateAskMessage(requestId, "Thinking...", false, false);
        
        attachedFiles = [];
        renderActiveFiles();
    };

    askSend.addEventListener("click", () => sendAskMessage());

    // ── Theme Toggle ──────────────────────────────────────────────────────────
    const themeToggle = chicMenu.querySelector("#mt-theme-toggle");
    let mytakeTheme = "dark"; // default

    function applyTheme(theme) {
      mytakeTheme = theme;
      let isLight = false;
      if (theme === "light") {
        isLight = true;
      } else if (theme === "system" || theme === undefined) {
        isLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
      }

      if (isLight) {
        chicMenu.classList.add("mt-light");
        chicFab.classList.add("mt-light");
        if (contextualPopup) contextualPopup.classList.add("mt-light");
        if (targetPicker) targetPicker.classList.add("mt-light");
      } else {
        chicMenu.classList.remove("mt-light");
        chicFab.classList.remove("mt-light");
        if (contextualPopup) contextualPopup.classList.remove("mt-light");
        if (targetPicker) targetPicker.classList.remove("mt-light");
      }
    }

    // Load saved preference
    try {
      chrome.storage.local.get(["mytakeTheme"], (res) => {
        if (chrome.runtime.lastError) return;
        if (res.mytakeTheme) applyTheme(res.mytakeTheme);
      });
    } catch (_) {}

    themeToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      let next = "system";
      if (mytakeTheme === "system" || mytakeTheme === undefined) next = "dark";
      else if (mytakeTheme === "dark") next = "light";
      
      applyTheme(next);
      themeToggle.title = "Theme: " + next.charAt(0).toUpperCase() + next.slice(1);
      try { chrome.storage.local.set({ mytakeTheme: next }); } catch (_) {}
    });

    // Close on outside click
    document.addEventListener("click", (e) => {
      const path = e.composedPath ? e.composedPath() : [e.target];
      if (chicMenu.classList.contains("open") && !path.includes(chicMenu) && !path.includes(chicFab)) {
        chicMenu.classList.remove("open");
      }
    });

    // Contextual popup logic
    contextualPopup.querySelector("#ctx-close").addEventListener("click", () => hideContextualPopup());
    
    let ctxSelectedMood = null;
    contextualPopup.querySelectorAll(".ctx-mood-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (!aiReady) return;
        const moodId = btn.dataset.mood;
        contextualPopup.querySelectorAll(".ctx-mood-btn").forEach(b => b.classList.remove("ctx-mood-selected"));
        btn.classList.add("ctx-mood-selected");
        // Auto-apply the mood immediately
        const el = lockedTargetEl;
        if (el) {
            const customV = ctxInput.value.trim();
            hideContextualPopup();
            if (customV) {
                applyIntentTargetMode(el, customV);
            } else {
                applyIntentTargetMode(el, "mood:" + moodId);
            }
            ctxSelectedMood = null;
        }
      });
    });

    const ctxInput = contextualPopup.querySelector("#ctx-custom-input");
    const applyCustom = () => {
      const v = ctxInput.value.trim();
      const el = lockedTargetEl;
      if (ctxSelectedMood) {
        hideContextualPopup();
        if (v) {
          applyIntentTargetMode(el, v);
        } else {
          applyIntentTargetMode(el, "mood:" + ctxSelectedMood);
        }
        ctxSelectedMood = null;
      } else if (v) {
        hideContextualPopup();
        applyIntentTargetMode(el, v);
      }
    };
    const askCustom = () => {
      const v = ctxInput.value.trim();
      
      if (!isCtxChatActive) {
         isCtxChatActive = true;
         contextualPopup.querySelector(".ctx-moods").style.display = "none";
         const header = contextualPopup.querySelector(".ctx-header");
         if (header.firstChild) header.firstChild.textContent = "Target Chat ";
         contextualPopup.querySelector("#ctx-apply-btn").style.display = "none";
         contextualPopup.querySelector("#ctx-ask-btn").style.display = "";
         contextualPopup.querySelector("#ctx-ask-btn").textContent = "Send";
         contextualPopup.querySelector("#ctx-ask-messages").style.display = "flex";
      }
      
      if (v) {
         const el = lockedTargetEl;
         const text = el ? (el.innerText || "") : "";
         ctxInput.value = "";
         sendAskMessage(v, text);
      }
    };
    contextualPopup.querySelector("#ctx-apply-btn").addEventListener("click", applyCustom);
    contextualPopup.querySelector("#ctx-ask-btn").addEventListener("click", askCustom);
    ctxInput.addEventListener("keydown", (e) => { 
        e.stopPropagation();
        if(e.key === "Enter") {
            if (isCtxChatActive) askCustom();
            else applyCustom();
        } 
        if(e.key === "Escape") hideContextualPopup();
    });
    ctxInput.addEventListener("keyup", (e) => e.stopPropagation());
    ctxInput.addEventListener("keypress", (e) => e.stopPropagation());

    let ctxDrag = { isDragging: false, startX: 0, startY: 0, initialLeft: 0, initialTop: 0 };
    const header = contextualPopup.querySelector(".ctx-header");
    header.style.cursor = "move";
    header.addEventListener("mousedown", (e) => {
      if (e.target.id === "ctx-close") return;
      ctxDrag.isDragging = true;
      ctxDrag.startX = e.clientX;
      ctxDrag.startY = e.clientY;
      const rect = contextualPopup.getBoundingClientRect();
      ctxDrag.initialLeft = rect.left;
      ctxDrag.initialTop = rect.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (ctxDrag.isDragging) {
        const dx = e.clientX - ctxDrag.startX;
        const dy = e.clientY - ctxDrag.startY;
        contextualPopup.style.left = (ctxDrag.initialLeft + dx) + "px";
        contextualPopup.style.top = (ctxDrag.initialTop + dy) + "px";
        contextualPopup.style.bottom = "auto";
        contextualPopup.style.right = "auto";
      }
    });
    document.addEventListener("mouseup", () => {
      ctxDrag.isDragging = false;
    });
  }

    function showContextualPopup(x, y) {
    console.log("[MyTake] Showing contextual popup at", x, y);

    isCtxChatActive = false;
    contextualPopup.querySelector(".ctx-moods").style.display = "";
    const header = contextualPopup.querySelector(".ctx-header");
    if (header.firstChild) header.firstChild.textContent = 'Select Mood or Custom Prompt ';
    contextualPopup.querySelector("#ctx-apply-btn").style.display = "";
    contextualPopup.querySelector("#ctx-ask-btn").style.display = "";
    contextualPopup.querySelector("#ctx-ask-btn").textContent = "Ask AI";
    contextualPopup.querySelector("#ctx-custom-input").placeholder = "Ask about this element...";
    contextualPopup.querySelectorAll(".ctx-mood-btn").forEach(b => b.classList.remove("ctx-mood-selected"));
    
    const msgContainer = contextualPopup.querySelector("#ctx-ask-messages");
    msgContainer.style.display = "none";

    const historyHTML = lockedTargetEl ? targetChatHistory.get(lockedTargetEl) : null;
    if (historyHTML) {
        msgContainer.innerHTML = historyHTML;
    } else {
        msgContainer.innerHTML = "";
    }

    // clamp bounds
    const w = 240; const h = 260;
    let px = x + 15; let py = y + 15;
    if (px + w > window.innerWidth) px = window.innerWidth - w - 10;
    if (py + h > window.innerHeight) py = window.innerHeight - h - 10;
    
    // ensure coords are safe
    px = Math.max(10, px);
    py = Math.max(10, py);

    contextualPopup.style.left = px + "px";
    contextualPopup.style.top = py + "px";
    
    // Force reflow and add class
    contextualPopup.offsetHeight;
    contextualPopup.classList.add("open");

    setTimeout(() => {
        const input = contextualPopup.querySelector("#ctx-custom-input");
        if (input) input.focus();
    }, 50);
  }

  function wireCodeCopyButtons(container) {
     container.querySelectorAll(".mt-code-copy-btn").forEach(btn => {
        btn.onclick = () => {
           const codeEl = (chicMenu && chicMenu.querySelector("#" + btn.dataset.codeId)) || mytakeShadowRoot.querySelector("#" + btn.dataset.codeId);
           if (!codeEl) return;
           navigator.clipboard.writeText(codeEl.textContent).then(() => {
              btn.textContent = "Copied!";
              btn.style.color = "#10b981";
              setTimeout(() => { btn.textContent = "Copy"; btn.style.color = "rgba(255,255,255,0.6)"; }, 1500);
           });
        };
     });
  }

  function resetCtxChat() {
      if (!isCtxChatActive) return;
      isCtxChatActive = false;
      if (isAskGenerating) {
          postToMain("ASK_PAGE_ABORT", { requestId: currentAskRequestId });
          isAskGenerating = false;
      }

      if (lockedTargetEl) {
         const msgContainer = contextualPopup.querySelector("#ctx-ask-messages");
         if (msgContainer.innerHTML.trim() !== "") {
            targetChatHistory.set(lockedTargetEl, msgContainer.innerHTML);
         }
      }

      contextualPopup.querySelector(".ctx-moods").style.display = "";
      const header = contextualPopup.querySelector(".ctx-header");
      if (header.firstChild) header.firstChild.textContent = 'Select Mood or Custom Prompt ';
      contextualPopup.querySelector("#ctx-apply-btn").style.display = "";
      contextualPopup.querySelector("#ctx-ask-btn").style.display = "";
      contextualPopup.querySelector("#ctx-ask-btn").textContent = "Ask AI";
      contextualPopup.querySelector("#ctx-ask-messages").style.display = "none";
      contextualPopup.querySelector("#ctx-ask-messages").innerHTML = "";
      contextualPopup.querySelector("#ctx-custom-input").placeholder = "Ask about this element...";
      contextualPopup.style.width = "";
      contextualPopup.style.height = "";
      const resumeBtn = chicMenu.querySelector("#mt-resume-chat-btn");
      if (resumeBtn) resumeBtn.style.display = "none";
  }

  function hideContextualPopup() {
    contextualPopup.classList.remove("open");
    if (lockedTargetEl) {
      lockedTargetEl.classList.remove("mytake-target-locked");
      if (!isCtxChatActive) lockedTargetEl = null;
    }
    if (isCtxChatActive) {
        const resumeBtn = chicMenu.querySelector("#mt-resume-chat-btn");
        if (resumeBtn) resumeBtn.style.display = "flex";
    }
  }

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

    const uiStyleEl = document.createElement("style");
    uiStyleEl.id = "mytake-ui-styles";
    
    targetStyleEl.textContent = `
      body.mytake-target-active, body.mytake-target-active * { cursor: crosshair !important; }
      body.mytake-target-frozen, body.mytake-target-frozen * { cursor: default !important; }
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
        pointer-events: none !important;
      }
      .mytake-target-error {
        outline: 2px solid #ef4444 !important; outline-offset: 1px !important;
        background-color: rgba(239, 68, 68, 0.08) !important;
        pointer-events: none !important;
      }
      @keyframes mytake-pulse { 0%, 100% { outline-color: #f59e0b; } 50% { outline-color: #fcd34d; } }
      .mytake-target-locked {
        outline: 3px dashed var(--mt-active-color, #a78bfa) !important; outline-offset: 4px !important; background: color-mix(in srgb, var(--mt-active-color, #a78bfa) 10%, transparent) !important; transition: outline 0.2s;
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
    `;
    (document.head || document.documentElement).appendChild(targetStyleEl);

    uiStyleEl.textContent = `
      .mytake-picker-item, .mytake-picker-close, .mytake-picker-custom { cursor: pointer !important; }
      #mytake-custom-form button { cursor: pointer !important; }
      #mytake-custom-form input { cursor: text !important; }
      body.mytake-target-frozen, body.mytake-target-frozen * { cursor: default !important; }
      .mytake-picker-item, .mytake-picker-close, .mytake-picker-custom { cursor: pointer !important; }
      #mytake-custom-form button { cursor: pointer !important; }
      #mytake-custom-form input { cursor: text !important; }
      .mytake-fab {
        position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px;
        border-radius: 50%; display: flex; align-items: center; justify-content: center;
        cursor: pointer; z-index: 2147483647; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .mytake-fab.minimal {
        background: #000; color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1);
      }
      .mytake-fab.minimal:hover { transform: scale(1.05); }
      @media (prefers-color-scheme: light) {
        .mytake-fab.minimal { background: #fff; color: #000; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border: 1px solid rgba(0,0,0,0.1); }
      }
      .mytake-main-panel {
        position: fixed; bottom: 96px; right: 24px; width: 320px; max-width: calc(100vw - 48px);
        height: min(65vh, 480px, calc(100dvh - 120px));
        background: rgba(20,20,20,0.92); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
        border-radius: 20px; box-shadow: 0 16px 48px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.1);
        z-index: 2147483646; font-family: sans-serif;
        opacity: 0; pointer-events: none; transform: translateY(10px) scale(0.95);
        transition: opacity 0.3s cubic-bezier(0.2,0.9,0.3,1), transform 0.3s cubic-bezier(0.2,0.9,0.3,1), background 0.5s ease;
        overflow-y: auto; overflow-x: hidden; scrollbar-width: none;
        display: flex; flex-direction: column; align-items: center; padding: 16px 0; color: #fff;
      }
      .mytake-main-panel::-webkit-scrollbar { display: none; }
      .mytake-main-panel.open { opacity: 1; pointer-events: auto; transform: translateY(0) scale(1); }

      /* ── Theme Toggle Button ── */
      .mt-theme-toggle {
        position: absolute; top: 12px; right: 12px; z-index: 5;
        width: 32px; height: 32px; border-radius: 50%; border: none;
        background: rgba(255,255,255,0.1); color: #fff; cursor: pointer;
        display: grid; place-items: center;
        transition: background 0.2s, transform 0.2s;
      }
      .mt-theme-toggle:hover { background: rgba(255,255,255,0.2); transform: scale(1.1); }
      .mt-theme-icon-moon { display: none; }
      .mt-light .mt-theme-icon-sun { display: none; }
      .mt-light .mt-theme-icon-moon { display: block; }

      /* ── Light Mode Overrides ── */
      .mytake-main-panel.mt-light {
        background: rgba(255,255,255,0.92) !important;
        box-shadow: 0 16px 48px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.06);
        color: #1a1a2e;
      }
      .mytake-main-panel.mt-light .mt-theme-toggle {
        background: rgba(0,0,0,0.06); color: #333;
      }
      .mytake-main-panel.mt-light .mt-theme-toggle:hover { background: rgba(0,0,0,0.12); }
      .mytake-main-panel.mt-light .mt-globe-label { color: #1a1a2e; }
      .mytake-main-panel.mt-light .mt-item-label { color: #333; }
      .mytake-main-panel.mt-light .mt-carousel-item { color: #1a1a2e; }
      .mytake-main-panel.mt-light .mt-action-btn { color: #1a1a2e; border-color: rgba(0,0,0,0.15); }
      .mytake-main-panel.mt-light .mt-action-btn:hover { background: rgba(0,0,0,0.06); }
      .mytake-main-panel.mt-light .mt-ask-btn-icon { color: #1a1a2e; }
      .mytake-main-panel.mt-light .mt-ask-btn-icon:hover { background: rgba(0,0,0,0.06); }
      #mt-ask-input { color: #fdfdfd; }
      #mt-ask-input::placeholder { color: rgba(255,255,255,0.6); }
      .mytake-main-panel.mt-light #mt-ask-input { color: #1a1a2e; border-bottom-color: rgba(0,0,0,0.2); background: transparent; }
      .mytake-main-panel.mt-light #mt-ask-input:focus { border-bottom-color: var(--mt-active-color, #a78bfa) !important; background: transparent; }
      .mytake-main-panel.mt-light #mt-ask-input::placeholder { color: rgba(0,0,0,0.5); }
      .mytake-main-panel.mt-light #mt-slash-menu { background: #fff; border-color: rgba(0,0,0,0.15); color: #1a1a2e; }
      .mytake-main-panel.mt-light .mt-slash-item { color: #1a1a2e; }
      .mytake-main-panel.mt-light .mt-slash-item.selected { background: color-mix(in srgb, var(--mt-active-color, #a78bfa) 15%, transparent); }
      .mytake-main-panel.mt-light .mt-slash-item:hover { background: color-mix(in srgb, var(--mt-active-color, #a78bfa) 10%, transparent); }
      .mytake-main-panel.mt-light .mt-slash-empty { color: rgba(0,0,0,0.5); }
      .mytake-main-panel.mt-light #mt-ask-send { background: #1a1a2e !important; color: #fff !important; }
      .mytake-main-panel.mt-light .mt-ask-msg { background: rgba(0,0,0,0.05); color: #1a1a2e; border-color: rgba(0,0,0,0.1); }
      .mytake-main-panel.mt-light .mt-ask-user-msg { color: #1a1a2e; background: rgba(0,0,0,0.07); }
      .mytake-main-panel.mt-light .mt-custom-input-field {
        background: rgba(0,0,0,0.07); border-color: rgba(0,0,0,0.15); color: #1a1a2e;
      }
      .mytake-main-panel.mt-light #mt-custom-apply-btn {
        background: #1a1a2e; color: #fff;
      }
      .mytake-main-panel.mt-light .mt-target-btn {
        background: #1a1a2e; color: #fff;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      }
      .mt-mood-meta { text-align: center; margin-bottom: 8px; z-index: 1; position: relative; flex-shrink: 0; }
      .mt-globe-label { font-size: 16px; font-weight: 700; letter-spacing: -0.02em; }
      .mt-carousel-viewport { width: 100%; padding: 12px 16px; box-sizing: border-box; z-index: 1; position: relative; overflow-x: auto; scrollbar-width: none; scroll-behavior: smooth; }
      .mt-carousel-viewport::-webkit-scrollbar { display: none; }
      .mt-carousel-track { display: flex; flex-wrap: nowrap; justify-content: flex-start; gap: 12px; align-items: center; min-height: 70px; padding-bottom: 8px; }
      .mt-carousel-item {
        flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 8px;
        opacity: 0.55; cursor: pointer; transition: all 0.2s; color: inherit; position: relative;
      }
      .mt-carousel-item:hover { opacity: 0.85; }
      .mt-carousel-item.selected { opacity: 1; transform: scale(1.08); }
      .mt-item-swatch {
        width: 36px; height: 36px; border-radius: 50%;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2); border: 2px solid transparent;
        display: flex; align-items: center; justify-content: center;
        font-weight: bold; font-size: 16px;
      }
      .mt-item-label { font-size: 11px; font-weight: 600; color: inherit; }
      .mt-target-btn {
        width: 100%; background: transparent; border: 1px solid rgba(255,255,255,0.15); color: #fff;
        font-size: 13px; font-weight: 600; padding: 10px; border-radius: 999px;
        cursor: pointer; transition: background 0.2s; margin-top: 16px; display: block;
      }
      .mt-target-btn:hover { background: rgba(0,0,0,0.05); }
      body.dark-theme .mt-target-btn:hover { background: rgba(255,255,255,0.1); }
      .mytake-main-panel.mt-light .mt-target-btn:hover { background: rgba(0,0,0,0.08); }
      .mytake-contextual-popup.mt-light {
        background: rgba(255,255,255,0.95); border-color: rgba(0,0,0,0.1); color: #1a1a2e;
      }
      .mytake-contextual-popup.mt-light .ctx-header { color: #555; }
      .mytake-contextual-popup.mt-light .ctx-close:hover { color: #000; }
      .mytake-contextual-popup.mt-light .ctx-mood-btn {
        background: rgba(0,0,0,0.04); color: #111;
      }
      .mytake-contextual-popup.mt-light .ctx-mood-btn:hover { background: rgba(0,0,0,0.08); }
      .mytake-contextual-popup.mt-light .ctx-custom input {
        background: rgba(0,0,0,0.04); border-color: rgba(0,0,0,0.15); color: #111;
      }
      .mytake-contextual-popup.mt-light .ctx-custom input:focus { border-color: var(--mt-active-color, #a78bfa); background: #fff; }
      .mytake-contextual-popup.mt-light .ctx-custom button {
        background: #1a1a2e; color: #fff;
      }
      .mytake-contextual-popup.mt-light .ctx-custom button:hover { background: #2d2d4e; }
      
      .mt-ask-msg {
          background: rgba(255,255,255,0.3);
          padding: 12px;
          border-radius: 8px;
          font-size: 13px;
          color: #fff;
          position: relative;
          word-break: break-word;
          border: 1px solid rgba(255,255,255,0.1);
      }
      body.dark-theme .mt-ask-msg {
          background: rgba(255,255,255,0.1);
      }
      .mt-ask-user-msg {
          background: rgba(255,255,255,0.08);
          padding: 10px 12px;
          border-radius: 8px;
          font-size: 13px;
          color: #fff;
          align-self: flex-end;
          max-width: 85%;
          margin-bottom: 8px;
          word-break: break-word;
      }
      .mt-ask-btn-icon {
          background: transparent;
          border: none;
          color: #fff;
          cursor: pointer;
          padding: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          transition: background 0.2s;
      }
      .mt-ask-btn-icon:hover {
          background: rgba(0,0,0,0.05);
      }
      body.dark-theme .mt-ask-btn-icon:hover {
          background: rgba(255,255,255,0.1);
      }
      .mt-action-btn {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.15);
          color: #fff;
          font-size: 11.5px;
          font-weight: 600;
          padding: 6px 14px;
          border-radius: 999px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          transition: all 0.2s;
      }
      .mt-action-btn:hover {
          background: rgba(0,0,0,0.05);
      }
      .mytake-main-panel.mt-light .mt-action-btn:hover {
          background: rgba(0,0,0,0.05);
      }
      
      #mt-ask-input:focus {
          border-bottom-color: var(--mt-active-color, #a78bfa) !important;
      }
      #mt-slash-menu {
          background: #1a1a1a;
          border: 1px solid rgba(255,255,255,0.1);
          color: #fff;
      }
      .mt-slash-item {
          padding: 6px 8px; font-size: 11px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; color: rgba(255,255,255,0.8);
      }
      .mt-slash-item.selected { background: rgba(255,255,255,0.1); }
      .mt-slash-item:hover { background: rgba(255,255,255,0.05); }
      .mt-slash-empty { padding: 8px; font-size: 10px; color: rgba(255,255,255,0.5); text-align: center; }
      .mytake-contextual-popup.mt-light .ctx-mood-btn {
        background: rgba(0,0,0,0.03); color: #222;
      }
      .mytake-contextual-popup.mt-light .ctx-mood-btn:hover { background: rgba(0,0,0,0.08); }
      .mytake-contextual-popup.mt-light .ctx-custom input {
        background: #f5f5f5; border-color: rgba(0,0,0,0.12); color: #222;
      }
      .mytake-contextual-popup.mt-light .ctx-custom input:focus { border-color: var(--mt-active-color, #a78bfa); }
      .mytake-contextual-popup.mt-light .ctx-custom button {
        background: #1a1a2e; color: #fff;
      }
      .mytake-contextual-popup.mt-light .ctx-custom button:hover { background: #2d2d4e; }
      .mytake-contextual-popup.mt-light .ctx-custom #ctx-ask-btn {
        background: transparent; color: #111; border: 1px solid rgba(0,0,0,0.2);
      }
      .mytake-contextual-popup.mt-light .ctx-custom #ctx-ask-btn:hover { background: rgba(0,0,0,0.05); }
      .mytake-contextual-popup.mt-light .mt-ask-msg {
          background: rgba(0,0,0,0.05);
          color: #111;
          border: 1px solid rgba(0,0,0,0.1);
      }
      .mytake-contextual-popup.mt-light .mt-ask-user-msg {
          background: rgba(0,0,0,0.08);
          color: #111;
      }
      .mt-loader-container { display: flex; justify-content: flex-start; align-items: center; padding: 4px; }
      .mt-modern-spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: mt-spin 0.8s linear infinite; }
      .mytake-contextual-popup.mt-light .mt-modern-spinner { border-color: rgba(0,0,0,0.2); border-top-color: #111; }
      .mytake-main-panel.mt-light .mt-modern-spinner { border-color: rgba(0,0,0,0.2); border-top-color: #111; }
      @keyframes mt-spin { to { transform: rotate(360deg); } }

      /* Custom input field base styles */
      .mt-custom-input-field {
        width: 100%; padding: 10px 14px; border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.5);
        color: #fff; font-size: 13px; outline: none; box-sizing: border-box;
        transition: background 0.3s, border-color 0.3s, color 0.3s;
      }
      .mt-ambient { position: absolute; inset: -20%; pointer-events: none; transition: background 0.5s ease; z-index: 0; filter: blur(40px); }
      .mt-globe-container { position: relative; width: 100px; height: 100px; z-index: 1; margin-bottom: 8px; flex-shrink: 0; }
      .mt-clover { width: 100%; height: 100%; animation: mt-float 4s ease-in-out infinite; }
      @keyframes mt-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
      .mt-mood-meta { text-align: center; margin-bottom: 8px; z-index: 1; position: relative; flex-shrink: 0; }
      .mt-globe-label { font-size: 16px; font-weight: 700; letter-spacing: -0.02em; }
      .mt-carousel-viewport { width: 100%; padding: 12px 16px; box-sizing: border-box; z-index: 1; position: relative; overflow-y: auto; flex-shrink: 0; }
      .mt-carousel-track { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; align-items: center; min-height: 80px; }
      /* .mt-carousel-item defined below with final values */
      .mt-target-btn {
        margin-top: 16px; background: #fff; color: #000; border: none; padding: 12px 24px;
        border-radius: 24px; font-weight: 600; font-size: 14px; cursor: pointer; z-index: 1; position: relative;
        transition: transform 0.2s; box-shadow: 0 4px 12px rgba(255,255,255,0.2);
      }
      .mt-target-btn:hover { transform: scale(1.05); }

      /* Contextual Popup */
      .mytake-contextual-popup {
        position: fixed !important; background: rgba(30,30,30,0.98); backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 12px;
        width: 240px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        z-index: 2147483647 !important; font-family: sans-serif; color: #fff;
        opacity: 0; pointer-events: none; transform: scale(0.95);
        transition: opacity 0.15s ease-out, transform 0.15s ease-out; display: flex; flex-direction: column; gap: 12px;
        resize: both; overflow: hidden; min-width: 240px; min-height: 100px; max-width: 80vw; max-height: 80vh;
      }
      .mytake-contextual-popup.open { opacity: 1; pointer-events: auto; transform: scale(1); }
      .ctx-header { font-size: 12px; font-weight: 600; color: #aaa; display: flex; justify-content: space-between; align-items: center; }
      .ctx-close { cursor: pointer; padding: 0 4px; } .ctx-close:hover { color: #fff; }
      .ctx-moods { display: flex; flex-direction: row; gap: 8px; max-width: 100%; overflow-x: auto; padding-bottom: 8px; scrollbar-width: none; scroll-behavior: smooth; }
      .ctx-moods::-webkit-scrollbar { display: none; }
      .ctx-mood-btn { flex: 0 0 auto; background: rgba(255,255,255,0.05); color: #fff; border: none; padding: 6px 12px; text-align: center; border-radius: 16px; cursor: pointer; font-size: 12px; transition: background 0.1s; border-left: none !important; }
      .ctx-mood-btn:hover { background: rgba(255,255,255,0.15); }
      .ctx-mood-btn.ctx-mood-selected { background: rgba(255,255,255,0.2); outline: 2px solid var(--mt-active-color, #a78bfa); outline-offset: -2px; }
      .mytake-contextual-popup.mt-light .ctx-mood-btn.ctx-mood-selected { background: rgba(0,0,0,0.1); outline-color: var(--mt-active-color, #a78bfa); }
      .ctx-custom { display: flex; gap: 8px; margin-top: 4px; }
      .ctx-custom input { flex: 1; background: #000; border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 6px 8px; border-radius: 6px; font-size: 12px; outline: none; min-width: 0; }
      .ctx-custom input:focus { border-color: var(--mt-active-color, #a78bfa); }
      .ctx-custom button { background: #fff; color: #000; border: none; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; flex-shrink: 0; }
      .ctx-custom button:hover { background: #e0e0e0; }
      .ctx-custom #ctx-ask-btn { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,0.2); }
      .ctx-custom #ctx-ask-btn:hover { background: rgba(255,255,255,0.1); }

      .mytake-target-locked { outline: 3px dashed var(--mt-active-color, #a78bfa) !important; outline-offset: 4px !important; background: color-mix(in srgb, var(--mt-active-color, #a78bfa) 10%, transparent) !important; transition: outline 0.2s; }

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


      .mytake-fab {
        position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px;
        border-radius: 50%; background: linear-gradient(135deg, #1a1a2e, #16213e);
        color: white; box-shadow: 0 4px 16px rgba(99,102,241,0.3), 0 0 0 1px rgba(255,255,255,0.08) inset;
        display: flex; align-items: center; justify-content: center; cursor: pointer;
        z-index: 2147483647; transition: transform 0.2s cubic-bezier(0.2,0.9,0.3,1), box-shadow 0.2s ease;
      }
      .mytake-fab-clover { animation: mytake-fab-spin 8s linear infinite; }
      @keyframes mytake-fab-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      .mytake-fab:hover { transform: scale(1.05); box-shadow: 0 6px 16px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.1) inset; }
      .mytake-fab:active { transform: scale(0.95); }
      .mytake-fab.mt-light {
          background: linear-gradient(135deg, #fff, #f0f0f0);
          color: #1a1a2e;
          border: 1px solid rgba(0,0,0,0.1);
          box-shadow: 0 4px 16px rgba(0,0,0,0.15);
      }
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
      .mytake-picker-custom span:first-child { color: var(--mt-active-color, #a78bfa); font-size: 14px; }

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

      #mytake-floating-widget {
        position: fixed; z-index: 2147483647; min-width: 280px; max-width: 320px;
        background: rgba(20,20,20,0.92); backdrop-filter: blur(20px); border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.1);
        font-family: -apple-system, sans-serif; font-size: 13px; overflow: hidden; color: #fff;
        animation: mytake-picker-in 120ms cubic-bezier(0.2,0.9,0.3,1); transform-origin: top left;
        display: flex; flex-direction: column;
      }
      #mytake-floating-widget.mt-light {
        background: rgba(255,255,255,0.95); box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.07); color: #111;
      }
      .mytake-widget-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px 8px; border-bottom: 1px solid rgba(255,255,255,0.1);
      }
      #mytake-floating-widget.mt-light .mytake-widget-header { border-bottom-color: #f0f0f0; }
      .mytake-widget-title {
        font-weight: 700; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: rgba(255,255,255,0.6);
        display: flex; gap: 8px; align-items: center;
      }
      .mt-target-processing { opacity: 0.5; pointer-events: none; }
      
      /* ── AI Unavailable Disclaimer Overlay ── */
      .mt-disclaimer-overlay {
        display: none; position: absolute; inset: 0; z-index: 9999;
        background: rgba(20,20,20,0.95);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
        flex-direction: column; align-items: center; justify-content: center;
        padding: 24px; text-align: left; border-radius: 20px;
        color: #fff;
      }
      .mt-disclaimer-overlay.show { display: flex; }
      .mytake-main-panel.mt-light .mt-disclaimer-overlay { background: rgba(255,255,255,0.95); color: #1a1a2e; }
      
      .mt-disclaimer-content { width: 100%; max-width: 280px; }
      .mt-disclaimer-title { font-size: 15px; font-weight: 800; margin-bottom: 12px; color: #fcd34d; }
      .mytake-main-panel.mt-light .mt-disclaimer-title { color: #d97706; }
      
      .mt-disclaimer-steps { padding-left: 16px; color: #d1d5db; font-size: 12px; line-height: 1.5; margin-bottom: 12px; }
      .mytake-main-panel.mt-light .mt-disclaimer-steps { color: #4b5563; }
      .mt-disclaimer-steps li { margin-bottom: 6px; }
      
      .mt-disclaimer-detail { font-size: 11px; color: #9ca3af; line-height: 1.4; }
      .mytake-main-panel.mt-light .mt-disclaimer-detail { color: #6b7280; }
      
      .mt-btn-check {
        display: block; width: 100%; padding: 8px; margin-top: 16px;
        background: #fcd34d; color: #000; border: none; border-radius: 6px;
        font-weight: 600; cursor: pointer; text-align: center; font-size: 13px;
      }
      .mt-btn-check:hover { background: #fbbf24; }
      
      #mytake-floating-widget.mt-light .mytake-widget-title { color: #555; }
      .mytake-widget-status {
        font-weight: 600; font-size: 10px; padding: 2px 6px; border-radius: 4px;
        background: rgba(255,255,255,0.1); color: #ccc; text-transform: none; letter-spacing: 0;
      }
      #mytake-floating-widget.mt-light .mytake-widget-status { background: #f0f0f0; color: #888; }
      .mytake-widget-status.applying { background: #fef3c7; color: #d97706; }
      .mytake-widget-status.error { background: #fee2e2; color: #ef4444; }
      .mytake-widget-close {
        background: none; border: none; cursor: pointer; color: rgba(255,255,255,0.6); font-size: 14px;
        line-height: 1; padding: 2px 4px; border-radius: 4px; transition: background 80ms, color 80ms;
      }
      .mytake-widget-close:hover { background: rgba(255,255,255,0.1); color: #fff; }
      #mytake-floating-widget.mt-light .mytake-widget-close { color: #aaa; }
      #mytake-floating-widget.mt-light .mytake-widget-close:hover { background: #f0f0f0; color: #555; }
      .mytake-widget-input-wrapper {
        padding: 12px; display: flex; gap: 8px; flex-direction: column;
      }
      .mytake-widget-input {
        width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.5); color: #fff;
        border-radius: 6px; font-size: 13px; font-family: inherit; outline: none; transition: border-color 0.2s;
      }
      .mytake-widget-input:focus { border-color: #a78bfa; }
      #mytake-floating-widget.mt-light .mytake-widget-input { background: #f8f9fa; border-color: #e5e7eb; color: #111; }
      #mytake-floating-widget.mt-light .mytake-widget-input:focus { border-color: #1a73e8; background: #fff; }
      .mytake-widget-btn {
        align-self: flex-end; padding: 6px 14px; background: #a78bfa; color: #111;
        border: none; border-radius: 6px; font-weight: 600; font-size: 12px;
        cursor: pointer; transition: background 0.2s;
      }
      .mytake-widget-btn:hover { background: #c084fc; }
      .mytake-widget-btn:disabled { background: rgba(255,255,255,0.2); color: rgba(255,255,255,0.4); cursor: not-allowed; }
      #mytake-floating-widget.mt-light .mytake-widget-btn { background: #1a73e8; color: #fff; }
      #mytake-floating-widget.mt-light .mytake-widget-btn:hover { background: #1557b0; }
      #mytake-floating-widget.mt-light .mytake-widget-btn:disabled { background: #9aa0a6; color: #fff; }

      .mytake-widget-footer {
        padding: 6px 12px; text-align: center; font-size: 10px; color: #666;
        border-top: 1px solid rgba(255,255,255,0.08);
        display: flex; align-items: center; justify-content: center; gap: 4px;
      }
      .mytake-widget-heart { display: inline-flex; align-items: center; animation: mytake-heartbeat 1.2s ease-in-out infinite; }
      @keyframes mytake-heartbeat {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.25); }
      }
      .mytake-widget-author-link { color: #a78bfa; text-decoration: none; font-weight: 600; transition: color 0.2s; }
      .mytake-widget-author-link:hover { color: #c084fc; text-decoration: underline; }
      #mytake-floating-widget.mt-light .mytake-widget-footer { border-top-color: #e5e7eb; color: #999; }
      #mytake-floating-widget.mt-light .mytake-widget-author-link { color: #1a73e8; }
      #mytake-floating-widget.mt-light .mytake-widget-author-link:hover { color: #1557b0; }
    `;
    if (mytakeShadowRoot) {
      mytakeShadowRoot.appendChild(uiStyleEl);
    }
  }

  function removeTargetStyles() {
    // DO NOT REMOVE the style tag because it now contains all the UI CSS (FAB, Contextual Popup, Main Panel).
    // Target specific styles are handled by removing body classes like .mytake-target-active
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
    injectChicUI();
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
        const form = contextualPopup ? contextualPopup.querySelector("#mytake-custom-form") : null;
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
    if (!el) return false;
    if (el === mytakeShadowHost) return true;
    if (contextualPopup && contextualPopup.contains(el)) return true;
    if (targetPicker && targetPicker.contains(el)) return true;
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
    if (isTargetProcessing || (contextualPopup && contextualPopup.contains(e.target))) {
      return; // let interactions inside popup proceed
    }

    if (isPickerEl(e.target)) return;

    if (contextualPopup && contextualPopup.classList.contains("open")) {
      hideContextualPopup(); // clicking elsewhere closes popup
      e.preventDefault(); e.stopPropagation();
      return;
    }

    if (!targetModeActive) return;

    e.preventDefault();
    e.stopPropagation();
    
    const el = getBestTargetElement(e.target) || e.target;
    clearTargetHover();
    deactivateTargetMode();

    if (isCtxChatActive) resetCtxChat();

    lockedTargetEl = el;
    lockedTargetEl.classList.add("mytake-target-locked");
    
    showContextualPopup(e.clientX, e.clientY);
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
    showFloatingWidget(targetEl, clientX, clientY);
  }

  function showFloatingWidget(targetEl, clientX, clientY) {
    closePicker();
    const widget = document.createElement("div");
    widget.id = "mytake-floating-widget";
    if (mytakeShadowRoot.querySelector(".mytake-main-panel")?.classList.contains("mt-light")) {
      widget.classList.add("mt-light");
    }
    targetPicker = widget;
    
    const key = makePageKey(targetEl);
    const existingRegion = targetRegions[key];
    const initialPrompt = existingRegion?.customPrompt || "";

    const originalText = targetEl.innerText || targetEl.textContent || "";
    const charCount = originalText.length;
    const LIMIT = 2500;
    const isTooLarge = charCount > LIMIT;

    widget.innerHTML = `
      <div class="mytake-widget-header">
        <div class="mytake-widget-title">
          <span>AI Assistant</span>
          <span class="mytake-widget-status ${isTooLarge ? 'error' : ''}" id="ml-widget-status">${isTooLarge ? 'Too Large' : 'Ready'}</span>
        </div>
        <button class="mytake-widget-close" title="Close">✕</button>
      </div>
      <div class="mytake-widget-input-wrapper">
        <input type="text" class="mytake-widget-input" id="ml-widget-input" placeholder="e.g. Make this red, or Sound like a pirate..." value="${initialPrompt}" ${isTooLarge ? 'disabled' : ''}>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
           <span id="ml-widget-charcount" style="font-size:10px; color:${isTooLarge ? '#ef4444' : '#888'};">
              ${charCount} / ${LIMIT} chars
           </span>
           <button class="mytake-widget-btn" id="ml-widget-run" ${isTooLarge ? 'disabled' : ''}>Run</button>
        </div>
      </div>
      ${initialPrompt ? '<div style="display:flex; justify-content: flex-end"><button class="mytake-widget-btn" style="background:#cc0000" id="ml-widget-remove">Remove</button></div>' : ''}
      <div class="mytake-widget-footer">
        Made with
        <span class="mytake-widget-heart">
          <svg stroke="#ff4d6d" fill="#ff4d6d" stroke-width="1.5" viewBox="0 0 24 24" height="12" width="12" xmlns="http://www.w3.org/2000/svg">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
          </svg>
        </span>
        by
        <a target="_blank" rel="noopener noreferrer" class="mytake-widget-author-link" href="https://www.linkedin.com/in/mohit-singh-negi/">this guy</a>
      </div>
    `;

    if (mytakeShadowRoot) mytakeShadowRoot.appendChild(widget);
    else document.body.appendChild(widget);

    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = widget.offsetWidth || 320, ph = widget.offsetHeight || 100;
    let x = clientX + 12, y = clientY + 8;
    if (x + pw > vw - 8) x = clientX - pw - 8;
    if (y + ph > vh - 8) y = clientY - ph - 8;
    widget.style.left = Math.max(8, x) + "px";
    widget.style.top = Math.max(8, y) + "px";

    const input = widget.querySelector("#ml-widget-input");
    const runBtn = widget.querySelector("#ml-widget-run");
    const statusEl = widget.querySelector("#ml-widget-status");
    input.focus();

    widget.querySelector(".mytake-widget-close").addEventListener("click", (e) => {
      e.stopPropagation();
      dismissPicker();
    });

    if (initialPrompt) {
      widget.querySelector("#ml-widget-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        const walker = document.createTreeWalker(targetEl, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          if (n._mytakeOriginal) {
            n.textContent = n._mytakeOriginal;
            n._mytakeRephrased = undefined;
          }
        }
        if (targetEl._mytakeOriginalStyle !== undefined) {
          targetEl.style.cssText = targetEl._mytakeOriginalStyle;
        }
        delete targetRegions[key];
        dismissPicker();
      });
    }

    runBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const prompt = input.value.trim();
      if (!prompt) {
        input.focus();
        return;
      }
      
      targetEl.classList.remove("mytake-target-locked");
      targetEl.classList.add("mytake-target-processing");
      
      closePicker();
      showProcessingBadge(targetEl);
      
      console.log(`[MyTake-Dataset] Target Mode Request: "${prompt}" on Element: <${targetEl.tagName.toLowerCase()}>`);
      
      applyIntentTargetMode(targetEl, prompt, widget);
    });

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") runBtn.click();
      if (e.key === "Escape") dismissPicker();
    });
    input.addEventListener("keyup", (e) => e.stopPropagation());
    input.addEventListener("keypress", (e) => e.stopPropagation());

    setTimeout(() => {
      function outsideClick(ev) {
        if (!targetPicker) {
          document.removeEventListener("click", outsideClick, false);
          return;
        }
        if (ev && ev.composedPath && ev.composedPath().includes(targetPicker)) return;
        document.removeEventListener("click", outsideClick, false);
        dismissPicker();
      }
      document.addEventListener("click", outsideClick, false);
    }, 300);
  }

  function applyIntentTargetMode(targetEl, promptStr) {
    if (!targetEl) return;
    
    let finalPrompt = promptStr;
    if (finalPrompt.startsWith("mood:")) {
      const m = finalPrompt.split(":")[1];
      if (m === "original") {
         const walker = document.createTreeWalker(targetEl, NodeFilter.SHOW_TEXT);
         let n;
         while ((n = walker.nextNode())) {
           if (n._mytakeOriginal) { n.textContent = n._mytakeOriginal; n._mytakeRephrased = undefined; }
         }
         return;
      }
      finalPrompt = "Rewrite in a " + m + " style";
    }

    const reqId = "tgt-" + Date.now() + "-" + Math.random().toString(36).substr(2, 5);
    inflightRequests.set(reqId, targetEl);
    
    targetEl.classList.add("mytake-target-processing");
    showProcessingBadge(targetEl);
    
    inflightRequestCallbacks.set(reqId, {
      onSuccess: () => {
        targetEl.classList.remove("mytake-target-processing");
        targetEl.classList.add("mytake-target-done");
        removeProcessingBadge();
        setTimeout(() => targetEl.classList.remove("mytake-target-done"), 1400);
      },
      onError: (err) => {
        targetEl.classList.remove("mytake-target-processing");
        targetEl.classList.add("mytake-target-error");
        removeProcessingBadge();
        setTimeout(() => targetEl.classList.remove("mytake-target-error"), 1400);
      }
    });

    const originalText = targetEl.innerText || targetEl.textContent || "";
    const snapshot = getDOMSnapshot(targetEl);
    const childTags = Array.from(targetEl.children).map(child => child.tagName.toLowerCase());
    inflightSnapshots.set(reqId, childTags);

    postToMain("INTENT_REQUEST", {
      requestId: reqId,
      prompt: finalPrompt,
      text: originalText.substring(0, 1000),
      html: targetEl.outerHTML.substring(0, 1500),
      snapshot: snapshot
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
    if (mytakeShadowRoot) mytakeShadowRoot.appendChild(badge);
    else document.body.appendChild(badge);
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

    if (mytakeShadowRoot) mytakeShadowRoot.appendChild(badge);
    else document.body.appendChild(badge);
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
        nodeState.set(n, "COMPLETED");
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
      nodeState.set(node, "PROCESSING");
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


    if (msg.type === "GLOBAL_INTENT_REQUEST") {
      const prompt = msg.prompt;
      const reqId = "intent-global-" + Date.now() + "-" + Math.random().toString(36).substr(2, 5);
      
      inflightRequestCallbacks.set(reqId, {
        onSuccess: () => {
          sendResponse({ success: true });
        },
        onError: (err) => {
          sendResponse({ success: false, error: err });
        }
      });
      
      inflightRequests.set(reqId, document.body);
      
      let textContent = document.body.innerText || "";
      
      postToMain("INTENT_REQUEST", {
        requestId: reqId,
        prompt: prompt,
        text: textContent.substring(0, 1000),
        html: "" // Empty HTML for global UI to prevent massive context size
      });
      
      return true; // Keep channel open for sendResponse
    }
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

    // Always inject the FAB and styles on page load
    injectChicUI();
    injectTargetStyles();

    if (mode === "target") activateTargetMode();
    if (enabled) postToMain("PING");
  });

  // ── Ask AI Markdown Formatter ──────────────────────────────────────────────
  let _codeBlockId = 0;
  function formatMarkdown(text) {
     if (!text) return "";
     let html = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
     
     // Fenced code blocks with language and copy button
     html = html.replace(/```([a-zA-Z]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
        const id = "mt-code-" + (++_codeBlockId);
        const langLabel = lang ? `<span style="position:absolute;top:4px;left:8px;font-size:10px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.5px;">${lang}</span>` : "";
        return `<div style="position:relative; margin:8px 0;">
          ${langLabel}
          <button class="mt-code-copy-btn" data-code-id="${id}" style="position:absolute;top:4px;right:6px;background:rgba(255,255,255,0.1);border:none;color:rgba(255,255,255,0.6);font-size:10px;padding:2px 8px;border-radius:4px;cursor:pointer;transition:all 0.2s;" title="Copy code">Copy</button>
          <pre id="${id}" style="background:rgba(0,0,0,0.4);padding:${lang ? '24px' : '10px'} 10px 10px 10px;border-radius:8px;overflow-x:auto;font-family:'Cascadia Code','Fira Code',monospace;font-size:11.5px;line-height:1.5;white-space:pre;margin:0;border:1px solid rgba(255,255,255,0.06);">${code.trim()}</pre>
        </div>`;
     });
     // Inline code
     html = html.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.12);padding:1px 5px;border-radius:4px;font-family:\'Cascadia Code\',\'Fira Code\',monospace;font-size:11.5px;">$1</code>');
     // Headings
     html = html.replace(/^### (.*)$/gm, '<div style="font-size:13px;font-weight:700;margin:10px 0 4px;">$1</div>');
     html = html.replace(/^## (.*)$/gm, '<div style="font-size:14px;font-weight:700;margin:12px 0 4px;">$1</div>');
     html = html.replace(/^# (.*)$/gm, '<div style="font-size:15px;font-weight:700;margin:14px 0 6px;">$1</div>');
     // Bold
     html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
     // Italic
     html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
     // Links
     html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--mt-active-color, #a78bfa); text-decoration:underline;">$1</a>');
     // Numbered lists
     html = html.replace(/^\d+\.\s(.*)$/gm, '<li style="margin-left:20px;list-style:decimal;">$1</li>');
     // Unordered lists
     html = html.replace(/^(?:-|\*) (.*)$/gm, '<li style="margin-left:20px;">$1</li>');
     // Convert consecutive lis to ul/ol
     html = html.replace(/(<li style="margin-left:20px;">.*<\/li>\n?)+/g, match => `<ul style="margin:8px 0; padding-left:0;">${match}</ul>`);
     html = html.replace(/(<li style="margin-left:20px;list-style:decimal;">.*<\/li>\n?)+/g, match => `<ol style="margin:8px 0; padding-left:20px;">${match}</ol>`);
     
     // Special loader marker
     html = html.replace("__LOADING_SPINNER__", '<div class="mt-loader-container"><div class="mt-modern-spinner"></div></div>');
     
     // Newlines
     html = html.replace(/\n/g, '<br/>');
     html = html.replace(/(<br\/>){3,}/g, '<br/><br/>');
     
     return html;
  }

  function updateAskMessage(requestId, text, isDone, isError) {
     const messagesContainer = isCtxChatActive ? mytakeShadowRoot.querySelector("#ctx-ask-messages") : chicMenu.querySelector("#mt-ask-messages");
     let isAtBottom = false;
     if (messagesContainer) {
        isAtBottom = (messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight) < 15;
     }

     let msgEl = mytakeShadowRoot.querySelector("#ask-msg-" + requestId);
     if (!msgEl) {
        msgEl = document.createElement("div");
        msgEl.id = "ask-msg-" + requestId;
        msgEl.className = "mt-ask-msg";
        msgEl.dataset.isThinking = "true";
        if (messagesContainer) {
           messagesContainer.appendChild(msgEl);
        }
        isAtBottom = true; // force scroll for the very first chunk
     }
     
     if (isError) {
        msgEl.dataset.isThinking = "false";
        msgEl.style.borderLeft = "4px solid #ef4444";
        msgEl.innerHTML = `<div style="color: #ef4444; font-weight: bold; font-size:12px;">⚠️ ${text}</div>`;
     } else {
        msgEl.dataset.isThinking = "false";
        
        if (text === "__LOADING_SPINNER__") {
            msgEl.style.background = "transparent";
            msgEl.style.borderColor = "transparent";
            msgEl.style.boxShadow = "none";
        } else {
            msgEl.style.background = "";
            msgEl.style.borderColor = "";
            msgEl.style.boxShadow = "";
        }
        
        // text contains the full accumulated string
        msgEl.innerHTML = formatMarkdown(text);
     }
     
     if (isDone) {
        if (isCtxChatActive) {
            const btn = mytakeShadowRoot.querySelector("#ctx-ask-btn");
            if (btn) btn.textContent = "Send";
        } else {
            const sendIcon = chicMenu.querySelector("#mt-send-icon");
            const stopIcon = chicMenu.querySelector("#mt-stop-icon");
            if (sendIcon) sendIcon.style.display = "block";
            if (stopIcon) stopIcon.style.display = "none";
        }
        // mark generating as done via custom event
        chicMenu && chicMenu.dispatchEvent(new CustomEvent("ask-done"));
        
        if (!isError) {
            wireCodeCopyButtons(msgEl);
            
            const copyBtn = document.createElement("button");
            copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
            copyBtn.style.cssText = "position: absolute; top: 8px; right: 8px; background: transparent; border: none; color: inherit; opacity:0.5; cursor: pointer; transition: opacity 0.2s;";
            copyBtn.title = "Copy All";
            copyBtn.onclick = () => {
                navigator.clipboard.writeText(text).then(() => {
                    copyBtn.style.opacity = "1";
                    copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
                    setTimeout(() => {
                      copyBtn.style.opacity = "0.5";
                      copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
                    }, 2000);
                });
            };
            msgEl.style.position = "relative";
            msgEl.appendChild(copyBtn);
        }
     }
     
     if (messagesContainer && isAtBottom) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
     }
  }
})();
