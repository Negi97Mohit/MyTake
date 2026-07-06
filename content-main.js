// content-main.js — MyTake v2.0 AI Bridge (MAIN world)
// Accesses window.LanguageModel / window.ai for AI operations.
// Single shared session for all rephrasing — mood style goes into each prompt,
// never into the systemPrompt. This means exactly ONE lm.create() per page load.

(() => {
  "use strict";
  const TAG = "[MyTake-AI]";
  const CHANNEL = "MYTAKE_BRIDGE";

  // ── Single shared session ─────────────────────────────────────────────────
  let sharedSession = null;
  let sharedIntentSession = null;
  let sharedAskSession = null;
  let lastPageContext = null;
  let sessionInitializing = false;
  let sessionDead = false;
  let initAttempts = 0;
  const MAX_INIT_ATTEMPTS = 1;

  // ── Serial request queue ──────────────────────────────────────────────────
  const requestQueue = [];
  let queueActive = false;
  const activeAskControllers = {};

  let nanoBusy = Promise.resolve(); // global mutex — one Nano session in flight at a time

  async function withNanoSession(sysPromptText, userPrompt, { timeoutMs = 60000 } = {}) {
    const run = nanoBusy.then(async () => {
      const lm = getAPI();
      if (!lm) throw new Error('nano-unavailable');
      const avail = typeof lm.availability === "function" ? await lm.availability() : (await lm.capabilities()).available;
      if (avail === 'no') throw new Error('nano-unavailable');

      const controller = new AbortController();
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          console.warn(`${TAG} Nano session timed out after ${timeoutMs}ms`);
          controller.abort();
          reject(new Error(`Timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      let session;
      const taskPromise = (async () => {
        const createOpts = { signal: controller.signal };
        if (sysPromptText) createOpts.systemPrompt = sysPromptText;
        session = await lm.create(createOpts);
        console.log(`${TAG} Nano session created, prompting...`);
        return await session.prompt(userPrompt, { signal: controller.signal });
      })();

      try {
        return await Promise.race([taskPromise, timeoutPromise]);
      } finally {
        clearTimeout(timer);
        session?.destroy();
      }
    });
    nanoBusy = run.catch(() => {}); // a rejection must not poison the queue for the next call
    return run;
  }

  const PHASE = {
    FRAMING: 'Planning',
    CLASSIFYING: 'Classifying',
    IMPLEMENTING: 'Implementing',
    JUDGING: 'Finalizing',
  };

  function postPhase(requestId, phase, detail) {
    console.log(`[MyTake Phase: ${phase}]`, detail ?? '');
    post('INTENT_PHASE_UPDATE', { requestId, phase, detail });
  }

  const MOOD_PROMPTS = {
    explain:
      "Explain this in very simple terms, like I am 5 years old. Break down complex concepts into basic ideas.",
    donald:
      "Rephrase this in the speaking style of Donald J. Trump. Use his characteristic speech patterns, repetition, superlatives, and exclamations.",
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
    // Disabled: Do not aggressively open chrome://components/
    console.log(`${TAG} triggerModelUpdate called, but disabled to prevent spam.`);
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

    if (availability === "after-download") {
      console.log(
        `${TAG} Model requires download. Propagating downloading status.`,
      );
      post("AI_STATUS", { available: false, error: "downloading" });
    }

    try {
      console.log(`${TAG} Creating shared session...`);
      const monitorCallback = (m) => {
        m.addEventListener("downloadprogress", (e) => {
          console.log(`${TAG} Download progress: ${e.loaded}/${e.total}`);
          post("DOWNLOAD_PROGRESS", { loaded: e.loaded, total: e.total });
        });
      };

      const systemPrompt =
        "You are a text rephraser. Follow the style instruction given in each request exactly. Output ONLY the rephrased text — no preamble, no quotes, no commentary.";

      const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      const withTimeout = (promise, ms, desc) => {
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`${desc} timed out after ${ms}ms`));
          }, ms);
        });
        return Promise.race([
          promise.finally(() => clearTimeout(timeoutId)),
          timeoutPromise,
        ]);
      };

      try {
        sharedSession = await withTimeout(
          lm.create({
            systemPrompt: systemPrompt,
            temperature: 0.6,
            topK: 40,
            expectedLanguage: "en", outputLanguage: "en",
            monitor: monitorCallback,
          }),
          SESSION_TIMEOUT_MS,
          "Standard create",
        );
      } catch (err) {
        console.warn(
          `${TAG} Standard create failed, trying fallback configurations:`,
          err.message,
        );
        try {
          sharedSession = await withTimeout(
            lm.create({
              systemPrompt: systemPrompt,
              expectedLanguage: "en", outputLanguage: "en",
              monitor: monitorCallback,
            }),
            SESSION_TIMEOUT_MS,
            "Fallback create",
          );
        } catch (err2) {
          console.warn(
            `${TAG} Fallback with systemPrompt + monitor failed, trying empty/simple create:`,
            err2.message,
          );
          sharedSession = await withTimeout(
            lm.create({ expectedLanguage: "en", outputLanguage: "en" }),
            SESSION_TIMEOUT_MS,
            "Simple create",
          );
        }
      }

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
  async function enqueue(item) {
    // Model Availability Circuit Breaker Pre-flight check
    if (item.typePrefix !== "INTENT") {
      const avail = await checkAvailability();
      if (avail === "no" || avail === "unavailable" || avail === "no_api") {
        console.warn(`${TAG} Circuit Breaker: Model unavailable before request`);
        post(`${item.typePrefix}_FAIL`, {
          requestId: item.requestId,
          error: "Model unavailable",
        });
        post("AI_STATUS", { available: false, error: avail });
        return;
      }
    }
    if (sessionDead && item.typePrefix !== "INTENT") {
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
    
    const nextItem = requestQueue[0];

    if (nextItem.typePrefix !== "INTENT") {
      if (sessionDead) {
        requestQueue.shift();
        post(`${nextItem.typePrefix}_FAIL`, { requestId: nextItem.requestId, error: "Model unavailable" });
        drainQueue();
        return;
      }
      if (!sharedSession) {
        initSharedSession().then((ok) => {
          if (ok) drainQueue();
        });
        return;
      }
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
    if (item.typePrefix === "INTENT") {
      await doIntent(item.requestId, item.prompt, item.text, item.html, item.snapshot);
      return;
    }

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
        sessionDead = false; // Allow retry on next request

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

  // ── Job classification ──────────────────────────────────────────────────
  // Decides HOW the prompt should be applied to the selected element:
  //   LOCATE_AND_MODIFY    → output DOM shape ≈ input DOM shape. We find
  //                          specific text/nodes and tweak a narrow property
  //                          (style, or a substring's text). 1:1 node mapping.
  //   TRANSFORM_AND_REPLACE → the user wants a new end-state generated from
  //                          the old content as raw material. Old structure
  //                          (lists, paragraphs, etc.) is discarded — no
  //                          per-node mapping, the whole boundary is swapped.
  //
  // `operation` sub-routes LOCATE_AND_MODIFY:
  //   style        → existing CSS-object generation path
  //   text_pattern → NEW: substring-level targets ("words starting with T",
  //                  "the price") that don't map to whole text nodes
  //   rephrase     → existing per-text-node rephrase path (today's default)
  // =========================================================================
  // SECTION: INTENT CLASSIFIER (Think Phase)
  // =========================================================================
  // Live model call to classify the request and extract structural parameters.
  async function classifyJob(prompt, html, tools, snapshot) {
    const classifierPrompt =
      `You analyze a user's editing request against HTML they selected.\n` +
      `Request: "${prompt}"\n` +
      `Available tools: ${tools.map((t) => t.name).join(",") || "none"}\n` +
      `DOM Snapshot of the target element and its direct children:\n${snapshot || "None"}\n\n` +
      `Classify into ONE jobType:\n` +
      `- LOCATE_AND_MODIFY: output should keep the same DOM structure/shape. ` +
      `Finding specific text or nodes and changing a narrow property (style, ` +
      `a substring's text, or rephrasing existing text in place). Examples: ` +
      `"make this red", "underline words starting with T", "show the price in USD", ` +
      `"rewrite this in a formal tone".\n` +
      `- TRANSFORM_AND_REPLACE: output structure should NOT match input structure. ` +
      `New content is generated from the old content as raw material; old structure ` +
      `(lists, paragraphs, headings) is discarded or reshaped. Examples: "summarize ` +
      `this", "turn this into bullet points", "condense this to one sentence", ` +
      `"merge this list into a paragraph".\n` +
      `- STRUCTURAL_EDIT: used when the DOM tree itself must gain or lose nodes (creating, duplicating, or removing nodes).\n` +
      `- TOOL: the request requires calling one of the available tools.\n\n` +
      `If LOCATE_AND_MODIFY, also pick an operation:\n` +
      `- "style": a visual/CSS change (color, size, spacing, borders, etc.)\n` +
      `- "text_pattern": only specific words/substrings inside the text should change ` +
      `(not all the text, not a full rewrite) — e.g. "underline words starting with T", ` +
      `"show the price in USD"\n` +
      `- "rephrase": the existing text should be rewritten in place, same structure, ` +
      `same number of nodes — e.g. tone/style changes to the whole text\n\n` +
      `If STRUCTURAL_EDIT, decide which abstract change to perform on the DOM tree:\n` +
      `- "duplicate": create an equivalent copy of an existing node (either the target itself, or one of its indexed children from the DOM snapshot) such that it now co-exists alongside the original.\n` +
      `- "remove": delete an existing node (either the target itself, or one of its indexed children from the DOM snapshot) so it no longer exists.\n` +
      `- "insert": create content that does not currently exist and place it near a node (either the target itself, or one of its indexed children from the DOM snapshot).\n\n` +
      `STRICT STRUCTURAL_EDIT RULES:\n` +
      `1. You can only target direct children of the target element listed in the DOM Snapshot (one level deep). Do not try to target deeper nested elements.\n` +
      `2. If you cannot confidently identify which specific child index from the snapshot the user refers to, or if the request concerns the entire target container/element itself, you MUST return "targetIndex": null.\n` +
      `3. Never guess a targetIndex child index if it is ambiguous.\n\n` +
      `Respond ONLY with JSON, no markdown outside the JSON block. Do not include any explanation or preamble. The response must match this schema:\n` +
      `{\n` +
      `  "jobType": "LOCATE_AND_MODIFY" | "TRANSFORM_AND_REPLACE" | "STRUCTURAL_EDIT" | "TOOL",\n` +
      `  "operation": "style" | "text_pattern" | "rephrase" | null,\n` +
      `  "structuralOp": "duplicate" | "remove" | "insert" | null,\n` +
      `  "targetIndex": null, // integer index of the child node from the DOM snapshot, or null if referring to the target element itself or if ambiguous\n` +
      `  "insertPosition": "before" | "after" | "append" | "prepend" | null, // where to place new node relative to the target/child node\n` +
      `  "scopeNote": "<short explanation of change>"\n` +
      `}`;

    let result;
    try {
      result = await withNanoSession(null, classifierPrompt);
    } catch (err) {
      console.warn(`${TAG} Classifier Nano session failed:`, err);
      throw err; // bubble up to doIntent
    }
    
    const cleaned = result.replace(/```json/g, "").replace(/```/g, "").trim();

    console.log(`[MyTake Phase: Classifying] Diagnostics for "${prompt}":`, {
      framedInput: prompt,
      rawPromptPassedToModel: classifierPrompt,
      rawModelOutput: result,
      parsedOutput: cleaned
    });

    try {
      const parsed = JSON.parse(cleaned);
      if (parsed && parsed.jobType) return parsed;
    } catch (e) {
      console.warn(`${TAG} Classifier JSON parse failed, falling back:`, e.message);
    }
    // Fallback: preserve old default behavior (per-node rephrase) if parsing fails.
    return { jobType: "LOCATE_AND_MODIFY", operation: "rephrase", scopeNote: "entire selection" };
  }

  // =========================================================================
  // SECTION: INTENT HANDLERS REGISTRY (Act Phase - Generation)
  // =========================================================================
  const intentHandlers = new Map();

  intentHandlers.set("LOCATE_AND_MODIFY", async (params) => {
    const { prompt, text, html, job } = params;
    if (job.operation === "text_pattern") {
      const patternPrompt =
        `User request: "${prompt}"\n` +
        `Text: "${text}"\n\n` +
        `Find every exact substring in the text that the request refers to, and the ` +
        `exact replacement text for each (replacement may equal the original substring ` +
        `if the request only asks for styling, e.g. underlining — in that case set ` +
        `"style" instead of changing "replacement").\n` +
        `Output ONLY JSON, no markdown:\n` +
        `{"matches": [{"original": "<exact substring from text>", "replacement": "<new text, or same as original if unchanged>", "style": {<optional CSS properties to apply to just this substring>} }]}`;
      const patternResult = await withNanoSession(null, patternPrompt);
      const patternCleaned = patternResult.replace(/```json/g, "").replace(/```/g, "").trim();
      return { msgType: "INTENT_PATTERN_DONE", data: { matches: patternCleaned }, evaluateString: patternCleaned };
    }

    if (job.operation === "style") {
      const uiPrompt = `User prompt: "${prompt}"\nHTML: ${html}\nGenerate inline CSS styles to satisfy prompt. Output ONLY JSON mapping CSS properties to values, e.g. {"backgroundColor": "red"}. No markdown.`;
      const uiResult = await withNanoSession(null, uiPrompt);
      const uiCleaned = uiResult.replace(/```json/g, "").replace(/```/g, "").trim();
      return { msgType: "INTENT_UI_DONE", data: { css: uiCleaned }, evaluateString: uiCleaned };
    }

    // Default: rephrase
    return { msgType: "INTENT_TEXT_DONE", data: { prompt }, evaluateString: "Rephrase text" };
  });

  intentHandlers.set("TRANSFORM_AND_REPLACE", async (params) => {
    const { prompt, html } = params;
    const regenPrompt =
      `User request: "${prompt}"\n` +
      `Original HTML (the boundary to replace):\n${html}\n\n` +
      `Generate the replacement HTML for this entire boundary that satisfies the request. ` +
      `Use only simple, safe tags (p, ul, li, span, strong, em, h1-h6, br). ` +
      `Do not include script, style, or event-handler attributes. ` +
      `Output ONLY the replacement HTML fragment, no markdown fences, no commentary.`;
    const regenResult = await withNanoSession(null, regenPrompt);
    const regenCleaned = regenResult.replace(/```html/g, "").replace(/```/g, "").trim();
    return { msgType: "INTENT_REGENERATE_DONE", data: { html: regenCleaned }, evaluateString: regenCleaned };
  });

  intentHandlers.set("TOOL", async (params) => {
    const { prompt, tools } = params;
    if (tools.length === 0) {
      const fallbackHandler = intentHandlers.get("LOCATE_AND_MODIFY");
      return await fallbackHandler({ ...params, job: { jobType: "LOCATE_AND_MODIFY", operation: "style" } });
    }
    const toolPrompt = `Which tool? Available: ${tools.map(t=>t.name).join(',')}. Output ONLY the tool name.`;
    const toolResult = await withNanoSession(null, toolPrompt);
    const toolName = toolResult.replace(/```/g, "").trim();
    const targetTool = tools.find(t => t.name === toolName);

    if (targetTool) {
      const argsPrompt = `Given prompt "${prompt}", output JSON args for tool ${targetTool.name} (Schema: ${targetTool.inputSchema}). ONLY output valid JSON.`;
      const argsResult = await withNanoSession(null, argsPrompt);
      const argsCleaned = argsResult.replace(/```json/g, "").replace(/```/g, "").trim();
      const execResult = await document.modelContext.executeTool(targetTool, argsCleaned);
      console.log(`${TAG} Executed tool ${targetTool.name}:`, execResult);
      return { msgType: "INTENT_TOOL_DONE", data: {}, evaluateString: "Tool executed" };
    }
    const fallbackHandler = intentHandlers.get("LOCATE_AND_MODIFY");
    return await fallbackHandler({ ...params, job: { jobType: "LOCATE_AND_MODIFY", operation: "style" } });
  });

  intentHandlers.set("STRUCTURAL_EDIT", async (params) => {
    const { prompt, html, job } = params;
    const { structuralOp, targetIndex, insertPosition } = job;

    if (structuralOp === "duplicate" || structuralOp === "remove") {
      return { 
        msgType: "INTENT_STRUCTURAL_DONE", 
        data: { structuralOp, targetIndex, insertPosition }, 
        evaluateString: `Structural ${structuralOp}` 
      };
    }

    if (structuralOp === "insert") {
      const insertPrompt =
        `User request: "${prompt}"\n` +
        `Original HTML context:\n${html}\n\n` +
        `Generate a small HTML fragment to insert that satisfies the request. ` +
        `STRICT RULES:\n` +
        `- Use ONLY simple, safe tags: p, ul, li, span, strong, em, h1-h6, br.\n` +
        `- Do NOT include script, style, or event-handler attributes.\n` +
        `- You have no network access. Never fabricate specific external URLs, destinations, named entities, or unverifiable facts.\n` +
        `- If you include a link (a tag), it must not use a fabricated URL. Instead, build a generic query-style link derived from the page's visible context (e.g. href="?q=...") or use "#".\n` +
        `- Output ONLY the raw HTML fragment. Do not wrap in markdown code blocks or fences. No explanations.`;

      const generatedHtml = await withNanoSession(null, insertPrompt);
      const cleanedHtml = generatedHtml.replace(/```html/g, "").replace(/```/g, "").trim();
      return { 
        msgType: "INTENT_STRUCTURAL_DONE", 
        data: { structuralOp, targetIndex, insertPosition, html: cleanedHtml },
        evaluateString: cleanedHtml
      };
    }
  });

  async function runFramer(prompt, html) {
    const sysPrompt = `You are a prompt engineer. Your ONLY job is to rewrite the user's raw prompt into a clear, precise, declarative instruction describing WHAT needs to be done. NEVER execute the request. NEVER output HTML, CSS, or JSON. ONLY output the rewritten instruction string.`;
    const userPrompt = `Raw Prompt: "${prompt}"\nContext HTML: ${html}\n\nRewrite the Raw Prompt into a clear instruction:`;
    return await withNanoSession(sysPrompt, userPrompt);
  }

  async function runJudge(framedPrompt, html, evaluateString, jobType, structuralOp) {
    const isDestructive = jobType === "STRUCTURAL_EDIT" && (structuralOp === "remove" || structuralOp === "duplicate");
    const sysPrompt = `You are a judge. Evaluate if the proposed change satisfies the user's intent on the given HTML. You MUST output ONLY a JSON object with EXACTLY two keys: "passed" (boolean) and "reason" (string). If the intent cannot be fulfilled (e.g. missing data) or the proposed change fails to fulfill it, you MUST set "passed": false.`;
    const userPrompt = `Intent: "${framedPrompt}"\nHTML: ${html}\nProposed Change:\n${evaluateString}\n\nOutput {"passed": boolean, "reason": "short reason"} now:`;
    try {
      const result = await withNanoSession(sysPrompt, userPrompt);
      const cleaned = result.replace(/```json/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (typeof parsed.passed !== "boolean") {
        return { passed: true, reason: "Judge returned invalid schema, defaulting to pass" };
      }
      return parsed;
    } catch (e) {
      console.warn(`${TAG} Judge failed to parse, defaulting to pass:`, e);
      return { passed: true, reason: "Judge parsing failed" };
    }
  }

  async function doIntent(requestId, prompt, text, html, snapshot) {
    console.log(`${TAG} Starting INTENT for ${requestId}`);
    postPhase(requestId, PHASE.FRAMING, `Framing prompt: "${prompt}"`);

    let tools = [];
    if (document.modelContext && typeof document.modelContext.getTools === "function") {
      try {
        tools = await document.modelContext.getTools() || [];
      } catch (e) {}
    }

    try {
      // 1. Framing
      let framedPrompt = prompt;
      try {
        framedPrompt = await runFramer(prompt, html);
        console.log(`[MyTake Phase: Planning] "${prompt}" → "${framedPrompt}"`);
      } catch (e) {
        console.warn(`${TAG} Framer failed, falling back to raw prompt:`, e);
      }

      // 2. Classifying
      postPhase(requestId, PHASE.CLASSIFYING, "Determining operation type");
      const job = await classifyJob(framedPrompt, html, tools, snapshot);
      
      if (job.jobType === "STRUCTURAL_EDIT") {
        const { structuralOp, targetIndex } = job;
        let targetIsValid = false;
        if (targetIndex === null || targetIndex === undefined) {
          targetIsValid = true;
        } else if (Number.isInteger(targetIndex)) {
          const matches = snapshot ? snapshot.match(/- Index \d+:/g) : null;
          const numChildren = matches ? matches.length : 0;
          if (targetIndex >= 0 && targetIndex < numChildren) targetIsValid = true;
        }
        if (!targetIsValid || !["duplicate", "remove", "insert"].includes(structuralOp)) {
          console.warn(`${TAG} Validation failed for STRUCTURAL_EDIT. Falling back to rephrase.`);
          post("INTENT_TEXT_DONE", { requestId, prompt: framedPrompt });
          post("INTENT_PHASE_CLEANUP", { requestId });
          return;
        }
      }

      // 3. Implementing
      postPhase(requestId, PHASE.IMPLEMENTING, `Executing ${job.jobType}`);
      const handler = intentHandlers.get(job.jobType);
      if (!handler) {
        post("INTENT_TEXT_DONE", { requestId, prompt: framedPrompt });
        post("INTENT_PHASE_CLEANUP", { requestId });
        return;
      }
      
      const result = await handler({ requestId, prompt: framedPrompt, text, html, tools, job });
      
      // 4. Finalizing (Judging)
      postPhase(requestId, PHASE.JUDGING, "Verifying changes");
      const verdict = await runJudge(framedPrompt, html, result.evaluateString, job.jobType, job.structuralOp);
      console.log(`[MyTake Phase: Finalizing] Judge verdict:`, verdict);

      const isDestructive = job.jobType === "STRUCTURAL_EDIT" && ["remove", "duplicate", "insert"].includes(job.structuralOp);

      if (!verdict.passed && isDestructive) {
        post("INTENT_NEEDS_CONFIRMATION", { requestId, ...result.data, reason: verdict.reason });
      } else {
        post(result.msgType, { requestId, ...result.data, judgeWarning: verdict.passed ? null : verdict.reason });
      }

      post("INTENT_PHASE_CLEANUP", { requestId });
    } catch(err) {
       console.warn(`${TAG} Intent pipeline failed:`, err);
       post("INTENT_PHASE_CLEANUP", { requestId });
       post("INTENT_FAIL", { requestId, error: err.message || "Pipeline failed" });
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
          console.log(`[MyTake-Dataset] LLM Stream Completed:`, { input: prompt, output: final });
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
        console.log(`[MyTake-Dataset] LLM Prompt Completed:`, { input: prompt, output: trimmed });
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
  let currentMood = "original";
  let currentCustomPrompt = null;
  let currentIntensity = 2;

  function buildRephrasePrompt(text, moodKey, customPromptStr, intensity) {
    if (customPromptStr) {
      return `Instruction: ${customPromptStr}\n\nApply this instruction to the following text. Output ONLY the result, without any extra text, quotes, or commentary. Format it properly according to the instruction (e.g. use newlines for lists):\n\n${text}`;
    }
    let style = MOOD_PROMPTS[moodKey] || MOOD_PROMPTS.explain;
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
    if (text.length > 2500) {
      post("REPHRASE_FAIL", { requestId, error: "Context window breached select something smaller" });
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
    if (text.length > 2500) {
      post("COMMAND_FAIL", { requestId, error: "Context window breached select something smaller" });
      return;
    }
    const prompt = `Command: ${commandText}\nText: "${text}"\nApply the command to the text. Output ONLY the result, no commentary:`;
    enqueue({ requestId, prompt, typePrefix: "COMMAND" });
  }

  async function handleAskPage(requestId, question, pageContext, attachedFiles = []) {
    console.log(`${TAG} Starting ASK for ${requestId}`);
    const lm = getAPI();
    if (!lm) {
      post("ASK_PAGE_FAIL", { requestId, error: "AI not available. Make sure Chrome's built-in AI (Gemini Nano) is enabled." });
      return;
    }
    try {
      if (sharedAskSession && lastPageContext !== pageContext) {
          console.log(`${TAG} Page context changed, destroying old AskSession.`);
          sharedAskSession.destroy();
          sharedAskSession = null;
      }

      if (!sharedAskSession) {
        // Send a "creating session" stream update so user sees progress
        post("ASK_PAGE_STREAM", { requestId, text: "__LOADING_SPINNER__" });
        try {
          const sysPrompt = `You are a helpful AI assistant. You analyze webpages and attached files. The user will ask questions. Smartly determine whether the question relates to the webpage, the attached files, or both. Use ALL provided context to answer accurately. Be concise and use markdown formatting. Always reference attached file content when files are provided.`;
          
          sharedAskSession = await lm.create({
            systemPrompt: sysPrompt,
            temperature: 0.2,
            expectedLanguage: "en", outputLanguage: "en",
            monitor(m) {
              m.addEventListener("downloadprogress", e => {
                // post("ASK_PAGE_STREAM", { requestId, text: `__LOADING_SPINNER__` });
                console.log(`${TAG} AskSession download: ${e.loaded}/${e.total}`);
              });
            }
          });
          lastPageContext = pageContext;
        } catch (e) {
          console.warn(`${TAG} Standard Ask AI create failed, trying fallback with initialPrompts:`, e.message);
          try {
            sharedAskSession = await lm.create({
              initialPrompts: [{
                role: 'system',
                content: `You are a helpful AI assistant analyzing a webpage. The user will ask questions about it. Use the provided webpage context to answer accurately. Be concise and use markdown formatting.`
              }],
              expectedLanguage: "en", outputLanguage: "en"
            });
          } catch (e2) {
            console.warn(`${TAG} initialPrompts fallback also failed, using bare session:`, e2.message);
            sharedAskSession = await lm.create({ expectedLanguage: "en", outputLanguage: "en" });
          }
          lastPageContext = pageContext;
        }
        console.log(`${TAG} AskSession created successfully`);
      }
      
      // Smart context budgeting: Gemini Nano has limited context (~4k tokens ≈ ~12k chars).
      // Reserve space for files first, then fill remaining with page context.
      const PROMPT_BUDGET = 10000;
      let prompt = "";
      let usedChars = 0;

      // 1) Attached files get priority
      if (attachedFiles && attachedFiles.length > 0) {
        prompt += `--- ATTACHED FILES ---\n`;
        attachedFiles.forEach(f => {
           const fileContent = f.content.substring(0, 4000);
           prompt += `[File: ${f.name}]\n${fileContent}\n\n`;
           usedChars += fileContent.length + f.name.length + 20;
        });
      }

      // 2) Page context gets remaining budget
      if (pageContext && pageContext.trim().length > 0) {
        const remainingBudget = Math.max(1500, PROMPT_BUDGET - usedChars - 500);
        const trimmedContext = pageContext.substring(0, remainingBudget);
        prompt += `--- WEBPAGE CONTEXT ---\n${trimmedContext}\n\n`;
      }

      // 3) User question last
      prompt += `--- USER QUESTION ---\n${question}\n\nAnswer using BOTH the webpage context AND any attached files provided above. If files are attached, make sure to reference their content in your answer. If the user refers to "this" or "the page", they mean the webpage context.`;

      if (typeof sharedAskSession.promptStreaming === "function") {
        const controller = new AbortController();
        activeAskControllers[requestId] = controller;
        let accumulated = "";
        let lastSent = "";

        try {
          console.log(`${TAG} Calling promptStreaming...`);
          const stream = sharedAskSession.promptStreaming(prompt, { signal: controller.signal });
          console.log(`${TAG} promptStreaming returned, iterating...`);

          for await (const chunk of stream) {
            console.log(`${TAG} Stream chunk received (length: ${chunk?.length})`);
            const cur = typeof chunk === "string" ? chunk : String(chunk);
            if (cur.startsWith(accumulated)) accumulated = cur;
            else accumulated += cur;
            const t = accumulated;
            if (t && t !== lastSent) {
              lastSent = t;
              post("ASK_PAGE_STREAM", { requestId, text: t });
            }
          }
          console.log(`${TAG} Stream completed.`);
          const final = accumulated.trim();
          delete activeAskControllers[requestId];
          if (final) {
            post("ASK_PAGE_DONE", { requestId, text: final });
          } else {
            post("ASK_PAGE_FAIL", { requestId, error: "Empty stream output" });
          }
          return;
        } catch (err) {
          delete activeAskControllers[requestId];
          console.error(`${TAG} promptStreaming caught error:`, err);
          
          if (err === "USER_ABORT" || (err && err.name === "AbortError" && controller.signal.reason === "USER_ABORT")) {
             post("ASK_PAGE_DONE", { requestId, text: (accumulated + "\n\n*(Stopped)*").trim() });
             return;
          }
          
          const errStr = err?.message || String(err) || "";
          if (errStr.includes("destroyed") || errStr.includes("InvalidStateError") || errStr.includes("kErrorUnknown")) {
             sharedAskSession = null;
             post("ASK_PAGE_FAIL", { requestId, error: "The AI model crashed or the session was destroyed. The selected element may be too large or complex. Try highlighting a smaller area." });
             return;
          }
          
          if (err === "TIMEOUT" || err.name === "AbortError") {
             console.warn(`${TAG} Stream was aborted, falling back to prompt()`);
          } else {
             throw err;
          }
        }
      }

      console.log(`${TAG} Calling prompt (fallback)...`);
      const result = await sharedAskSession.prompt(prompt);
      console.log(`${TAG} prompt returned:`, result);
      if (result && result.trim()) {
        post("ASK_PAGE_DONE", { requestId, text: result.trim() });
      } else {
        post("ASK_PAGE_FAIL", { requestId, error: "Bad result" });
      }
    } catch (err) {
      delete activeAskControllers[requestId];
      
      const errStr = err?.message || String(err) || "";
      if (errStr.includes("destroyed") || errStr.includes("InvalidStateError") || errStr.includes("kErrorUnknown")) {
          sharedAskSession = null;
          console.error(`${TAG} Ask failed due to model crash:`, errStr);
          post("ASK_PAGE_FAIL", { requestId, error: "The AI model crashed or the session was destroyed. The selected element may be too large or complex. Try highlighting a smaller area." });
      } else {
          console.error(`${TAG} Ask failed`, err);
          post("ASK_PAGE_FAIL", { requestId, error: errStr });
      }
    }
  }

  let sessionNonce = null;

  function post(type, data) {
    if (!sessionNonce) {
      sessionNonce = document.documentElement.dataset.mytakeNonce;
    }
    window.postMessage(
      { channel: CHANNEL, direction: "TO_ISOLATED", type, nonce: sessionNonce, ...data },
      "*"
    );
  }

  // ── Message listener ──────────────────────────────────────────────────────
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.channel !== CHANNEL || msg.direction !== "TO_MAIN") return;
    
    if (!sessionNonce) {
      sessionNonce = document.documentElement.dataset.mytakeNonce;
    }
    if (msg.nonce !== sessionNonce) {
      console.warn("[MyTake] Main world rejected message with invalid nonce");
      return;
    }

    switch (msg.type) {
      case "INIT_SESSION":
        console.log(
          `${TAG} → INIT_SESSION (${msg.mood}, intensity: ${msg.intensity})`,
        );
        currentMood = msg.mood || "original";
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

      case "INTENT_REQUEST":
        enqueue({
          requestId: msg.requestId,
          prompt: msg.prompt,
          text: msg.text,
          html: msg.html,
          snapshot: msg.snapshot,
          typePrefix: "INTENT"
        });
        break;

      case "COMMAND_REQUEST":
        handleCommand(msg.requestId, msg.text, msg.commandText);
        break;

      case "ASK_PAGE_REQUEST":
        handleAskPage(msg.requestId, msg.question, msg.pageContext, msg.attachedFiles);
        break;

      case "ASK_PAGE_ABORT":
        if (activeAskControllers[msg.requestId]) {
           activeAskControllers[msg.requestId].abort("USER_ABORT");
        }
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
      } else if (status === "after-download") {
        post("AI_STATUS", { available: false, error: "downloading" });
      }
    });
  }
})();
