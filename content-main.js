// content-main.js — MoodLens v2.0 AI Bridge (MAIN world)
// Accesses window.LanguageModel / window.ai for AI operations.
// Single shared session for all rephrasing — mood style goes into each prompt,
// never into the systemPrompt. This means exactly ONE lm.create() per page load.

(() => {
  "use strict";
  const TAG = "[MoodLens-AI]";
  const CHANNEL = "MOODLENS_BRIDGE";

  // ── Single shared session ─────────────────────────────────────────────────
  let sharedSession = null;
  let sessionInitializing = false;
  let sessionDead = false;
  let initAttempts = 0;
  const MAX_INIT_ATTEMPTS = 1;

  // ── Serial request queue ──────────────────────────────────────────────────
  const requestQueue = [];
  let queueActive = false;

  const MOOD_PROMPTS = {
    standard: "Rephrase in clean, neutral, everyday style. Keep exact meaning.",
    cherry:
      "Rephrase in a warm, cheerful, uplifting tone — like a good friend sharing great news. Add brightness without changing facts.",
    honest:
      "Rephrase in a direct, clear, no-fluff style. Cut jargon. Say exactly what is meant.",
    "brutally-honest":
      "Rephrase in a blunt, no-nonsense tone. Strip all softening language. Say it straight, even if it stings.",
    academic:
      "Rephrase in formal academic register — precise terminology, measured tone, passive constructions where natural.",
    casual:
      "Rephrase like a laid-back friend texting — short, relaxed, a little playful. Keep the meaning, lose the formality.",
    poetic:
      "Rephrase with gentle poetic flair — evocative word choices, a light rhythm, nothing flowery. Still clear, just beautiful.",
  };

  // ── Resolve AI API ────────────────────────────────────────────────────────
  function getAPI() {
    for (const root of [window, self, globalThis]) {
      if (root.LanguageModel) return root.LanguageModel;
      if (root.AILanguageModel) return root.AILanguageModel;
      if (root.ai?.languageModel) return root.ai.languageModel;
      if (root.ai?.assistant) return root.ai.assistant;
    }
    return null;
  }

  async function checkAvailability() {
    const lm = getAPI();
    if (!lm) return "no_api";
    try {
      if (typeof lm.availability === "function") return await lm.availability();
      if (typeof lm.capabilities === "function") {
        const caps = await lm.capabilities();
        return caps?.available || "unknown";
      }
    } catch (_) {}
    return "unknown";
  }

  function triggerModelUpdate() {
    try {
      window.postMessage(
        {
          channel: CHANNEL,
          direction: "TO_ISOLATED",
          type: "REQUEST_MODEL_UPDATE",
        },
        "*",
      );
    } catch (_) {}
  }

  // ── Create the one shared session ─────────────────────────────────────────
  async function initSharedSession() {
    if (sharedSession) return true;
    if (sessionDead) return false;
    if (sessionInitializing) {
      await new Promise((r) => setTimeout(r, 200));
      return !!sharedSession;
    }
    if (initAttempts >= MAX_INIT_ATTEMPTS) {
      console.warn(`${TAG} Max init attempts reached. Not retrying.`);
      return false;
    }

    sessionInitializing = true;
    initAttempts++;

    const lm = getAPI();
    if (!lm) {
      sessionInitializing = false;
      sessionDead = true;
      post("AI_STATUS", { available: false, error: "no_api" });
      return false;
    }

    const availability = await checkAvailability();
    console.log(`${TAG} availability() → "${availability}"`);

    if (availability === "no" || availability === "no_api") {
      sessionInitializing = false;
      sessionDead = true;
      post("AI_STATUS", { available: false, error: "not_installed" });
      return false;
    }

    if (availability === "unavailable") {
      console.warn(
        `${TAG} Model unavailable (crash-blacklisted). Triggering update. Restart Chrome to recover.`,
      );
      triggerModelUpdate();
      sessionInitializing = false;
      sessionDead = true;
      post("AI_STATUS", { available: false, error: "crashed" });
      return false;
    }

    try {
      console.log(`${TAG} Creating shared session...`);
      sharedSession = await lm.create({
        systemPrompt:
          "You are a text rephraser. Follow the style instruction given in each request exactly. Output ONLY the rephrased text — no preamble, no quotes, no commentary.",
        temperature: 0.6,
        topK: 40,
        expectedLanguage: "en",
      });

      console.log(`${TAG} ✅ Shared session ready`);
      sessionInitializing = false;
      post("AI_STATUS", { available: true, mood: currentMood });
      drainQueue();
      return true;
    } catch (err) {
      console.error(`${TAG} Session creation failed:`, err.message);
      sessionInitializing = false;
      sessionDead = true;
      const msg = err.message || "";
      const errorCode =
        msg.toLowerCase().includes("crash") ||
        msg.toLowerCase().includes("unavailable")
          ? "crashed"
          : msg.toLowerCase().includes("download")
            ? "downloading"
            : "session_failed";
      post("AI_STATUS", { available: false, error: errorCode });
      return false;
    }
  }

  // ── Enqueue a request ─────────────────────────────────────────────────────
  function enqueue(item) {
    if (sessionDead) {
      post(`${item.typePrefix}_FAIL`, {
        requestId: item.requestId,
        error: "Model unavailable",
      });
      return;
    }
    requestQueue.push(item);
    drainQueue();
  }

  function drainQueue() {
    if (queueActive || requestQueue.length === 0) return;
    if (!sharedSession) {
      initSharedSession().then((ok) => {
        if (ok) drainQueue();
      });
      return;
    }
    if (sessionDead) {
      while (requestQueue.length > 0) {
        const item = requestQueue.shift();
        post(`${item.typePrefix}_FAIL`, {
          requestId: item.requestId,
          error: "Model unavailable",
        });
      }
      return;
    }

    const item = requestQueue.shift();
    queueActive = true;

    // Process item natively, waiting exactly as long as the model takes
    runItem(item).finally(() => {
      queueActive = false;
      drainQueue();
    });
  }

  async function runItem(item) {
    const { requestId, prompt, typePrefix } = item;
    console.log(`${TAG} Starting ${typePrefix} for ${requestId}`);

    if (!sharedSession || sessionDead) {
      post(`${typePrefix}_FAIL`, { requestId, error: "No session" });
      return;
    }

    try {
      // Note: We removed the artificial Promise.race timeout here.
      // We rely natively on the browser's model processing to finish.
      await doStream(requestId, prompt, typePrefix);
    } catch (err) {
      const msg = err.message || "";
      const isFatal =
        msg.includes("destroyed") || msg.includes("session has been destroyed");

      if (isFatal) {
        console.error(`${TAG} Session fatally dead: ${msg}`);
        sharedSession = null;
        sessionDead = true; // Hard-lock the session flag

        // Purge all pending requests immediately
        while (requestQueue.length > 0) {
          const qi = requestQueue.shift();
          post(`${qi.typePrefix}_FAIL`, {
            requestId: qi.requestId,
            error: "Model crashed",
          });
        }
        post("AI_STATUS", { available: false, error: "crashed" });
      } else {
        console.warn(
          `${TAG} Prompt error for ${requestId} (non-fatal): ${msg}`,
        );
      }
      post(`${typePrefix}_FAIL`, { requestId, error: msg });
    }
  }

  async function doStream(requestId, prompt, typePrefix) {
    if (typeof sharedSession.promptStreaming === "function") {
      try {
        const stream = sharedSession.promptStreaming(prompt);
        let accumulated = "";
        let lastSent = "";

        for await (const chunk of stream) {
          const cur = typeof chunk === "string" ? chunk : String(chunk);
          if (cur.startsWith(accumulated)) {
            accumulated = cur;
          } else {
            accumulated += cur;
          }
          const t = accumulated.trim();
          if (t && t !== lastSent) {
            lastSent = t;
            post(`${typePrefix}_STREAM`, { requestId, text: t });
          }
        }

        const final = accumulated.trim();
        if (final && final.length > 1) {
          post(`${typePrefix}_DONE`, { requestId, text: final });
        } else {
          post(`${typePrefix}_FAIL`, {
            requestId,
            error: "Empty stream output",
          });
        }
        return; // Success exit
      } catch (err) {
        // STRICT GUARDRAIL: If the session was destroyed by Chrome during stream,
        // DO NOT attempt the prompt() fallback. Throw immediately.
        if (
          err.message?.includes("destroyed") ||
          err.message?.includes("session has been destroyed")
        ) {
          throw err;
        }
        console.warn(
          `${TAG} promptStreaming failed for ${requestId}: ${err.message} — trying prompt()`,
        );
      }
    }

    // Non-streaming fallback (only triggers if streaming wasn't supported, or had a non-fatal filter error)
    try {
      const result = await sharedSession.prompt(prompt);
      const trimmed = result?.trim();
      if (trimmed && trimmed.length > 1) {
        post(`${typePrefix}_DONE`, { requestId, text: trimmed });
      } else {
        post(`${typePrefix}_FAIL`, { requestId, error: "Bad result" });
      }
    } catch (err) {
      if (
        err.message?.includes("destroyed") ||
        err.message?.includes("session has been destroyed")
      ) {
        throw err;
      }
      post(`${typePrefix}_FAIL`, {
        requestId,
        error: err.message || "prompt() failed",
      });
    }
  }

  // ── Build a prompt for mood rephrasing ────────────────────────────────────
  let currentMood = "standard";
  let currentCustomPrompt = null;
  let currentIntensity = 2;

  function buildRephrasePrompt(text, moodKey, customPromptStr, intensity) {
    let style =
      customPromptStr || MOOD_PROMPTS[moodKey] || MOOD_PROMPTS.standard;
    if (intensity === 1)
      style += " Be extremely subtle — change only 2–3 words max.";
    else if (intensity === 3)
      style +=
        " Transform heavily and expressively to fully capture the style.";
    return `Style: ${style}\n\nRewrite the following text in that style. STRICT RULES: same approximate length, no added sentences, no preamble, no quotes. Output ONLY the rewritten text:\n\n${text}`;
  }

  // ── Handlers (with strict empty string validation) ────────────────────────
  function handleRephrase(requestId, text) {
    if (!text || !text.trim()) {
      post("REPHRASE_FAIL", { requestId, error: "Empty text" });
      return;
    }
    const prompt = buildRephrasePrompt(
      text,
      currentMood,
      currentCustomPrompt,
      currentIntensity,
    );
    enqueue({ requestId, prompt, typePrefix: "REPHRASE" });
  }

  function handleTargetRephrase(requestId, text, systemPrompt) {
    if (!text || !text.trim()) {
      post("REPHRASE_FAIL", { requestId, error: "Empty text" });
      return;
    }
    const prompt = buildRephrasePrompt(text, null, systemPrompt, 2);
    enqueue({ requestId, prompt, typePrefix: "REPHRASE" });
  }

  function handleCommand(requestId, text, commandText) {
    if (!text || !text.trim() || !commandText || !commandText.trim()) {
      post("COMMAND_FAIL", { requestId, error: "Empty input" });
      return;
    }
    const prompt = `Command: ${commandText}\nText: "${text}"\nApply the command to the text. Output ONLY the result, no commentary:`;
    enqueue({ requestId, prompt, typePrefix: "COMMAND" });
  }

  function post(type, data) {
    window.postMessage(
      { channel: CHANNEL, direction: "TO_ISOLATED", type, ...data },
      "*",
    );
  }

  // ── Message listener ──────────────────────────────────────────────────────
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.channel !== CHANNEL || msg.direction !== "TO_MAIN") return;

    switch (msg.type) {
      case "INIT_SESSION":
        console.log(
          `${TAG} → INIT_SESSION (${msg.mood}, intensity: ${msg.intensity})`,
        );
        currentMood = msg.mood || "standard";
        currentCustomPrompt = msg.customPrompt || null;
        currentIntensity = msg.intensity || 2;
        if (sharedSession) {
          post("AI_STATUS", { available: true, mood: currentMood });
          return;
        }
        if (!sessionDead) initSharedSession();
        else post("AI_STATUS", { available: false, error: "crashed" });
        break;

      case "REPHRASE_REQUEST":
        handleRephrase(msg.requestId, msg.text);
        break;

      case "TARGET_REPHRASE_REQUEST":
        handleTargetRephrase(msg.requestId, msg.text, msg.systemPrompt);
        break;

      case "COMMAND_REQUEST":
        handleCommand(msg.requestId, msg.text, msg.commandText);
        break;

      case "DESTROY_SESSION":
        console.log(`${TAG} → DESTROY_SESSION`);
        requestQueue.length = 0;
        queueActive = false;
        break;

      case "PING":
        post("PONG", { hasAI: !!getAPI() });
        break;
    }
  });

  const hasAI = !!getAPI();
  console.log(`${TAG} Bridge loaded — AI present: ${hasAI}`);
  post("BRIDGE_READY", { hasAI });

  if (hasAI) {
    checkAvailability().then((status) => {
      if (status === "unavailable") {
        console.warn(
          `${TAG} Boot: model crash-blacklisted. Triggering update.`,
        );
        triggerModelUpdate();
        sessionDead = true;
        post("AI_STATUS", { available: false, error: "crashed" });
      } else if (status === "no") {
        sessionDead = true;
        post("AI_STATUS", { available: false, error: "not_installed" });
      }
    });
  }
})();
