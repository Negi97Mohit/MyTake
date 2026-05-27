// content-main.js — MoodLens v2.0 AI Bridge (MAIN world)
// Accesses window.LanguageModel / window.ai for AI operations.
// Handles mood rephrasing AND arbitrary AI commands.

(() => {
  'use strict';
  const TAG = '[MoodLens-AI]';
  const CHANNEL = 'MOODLENS_BRIDGE';

  let session = null;
  let commandSession = null;
  const requestQueue = [];
  let activeCount = 0;          // concurrent AI requests in flight
  const MAX_CONCURRENT = 3;    // process 3 nodes simultaneously
  let currentMood = 'standard';
  let currentCustomPrompt = null;
  let sessionInitializing = false;
  let cloningSupported = true;

  // ── Mood system prompts ───────────────────────────────────────────────────
  const MOOD_PROMPTS = {
    standard:          'You rephrase text in a clean, neutral, everyday style. Keep the exact meaning. Output ONLY the rephrased text, nothing else.',
    cherry:            'You rephrase text in a warm, cheerful, uplifting tone — like a good friend sharing great news. Add a little brightness without changing the facts. Output ONLY the rephrased text, nothing else.',
    honest:            'You rephrase text in a direct, clear, no-fluff style. Cut jargon. Say exactly what is meant. Output ONLY the rephrased text, nothing else.',
    'brutally-honest': 'You rephrase text in a blunt, no-nonsense tone. Strip all softening language. Say it straight, even if it stings. Never soften the message. Output ONLY the rephrased text, nothing else.',
    academic:          'You rephrase text in a formal academic register — precise terminology, measured tone, passive constructions where natural. Output ONLY the rephrased text, nothing else.',
    casual:            'You rephrase text like a laid-back friend texting — short, relaxed, maybe a little playful. Keep the meaning, lose the formality. Output ONLY the rephrased text, nothing else.',
    poetic:            'You rephrase text with gentle poetic flair — evocative word choices, a light rhythm, nothing flowery. Still clear, just beautiful. Output ONLY the rephrased text, nothing else.',
  };

  const COMMAND_SYSTEM_PROMPT = `You are a text editor. Apply the user's command to the text. Output ONLY the transformed text. Do not add explanations, quotes, or markdown.`;

  // ── Resolve AI API ────────────────────────────────────────────────────────
  function getAPI() {
    if (window.LanguageModel) return window.LanguageModel;
    if (self.LanguageModel)   return self.LanguageModel;
    if (globalThis.LanguageModel) return globalThis.LanguageModel;
    const ai = window.ai ?? self.ai ?? globalThis.ai ?? null;
    return ai?.languageModel ?? ai?.assistant ?? null;
  }

  // ── Session management ────────────────────────────────────────────────────
  let currentIntensity = 2;

  async function createSession(moodKey, customPromptText, intensity) {
    requestQueue.length = 0;
    activeCount = 0;
    currentMood = moodKey;
    currentCustomPrompt = customPromptText || null;
    currentIntensity = intensity || 2;
    sessionInitializing = true;

    if (session) {
      try { session.destroy(); } catch (_) {}
      session = null;
    }

    const lm = getAPI();
    if (!lm) {
      console.error(`${TAG} No AI API found`);
      sessionInitializing = false;
      post('AI_STATUS', { available: false, error: 'No AI API found. Enable chrome://flags/#prompt-api-for-gemini-nano' });
      return;
    }

    try {
      // Use custom prompt if provided, otherwise look up built-in
      let systemPrompt = currentCustomPrompt || MOOD_PROMPTS[moodKey] || MOOD_PROMPTS.standard;

      // Inject intensity constraints into systemPrompt
      if (currentIntensity === 1) {
        systemPrompt += " Keep the rephrasing extremely subtle and minimal. Only change 2 to 3 words if absolutely necessary to match the requested style. Otherwise, keep the original wording exactly.";
      } else if (currentIntensity === 3) {
        systemPrompt += " Transform the text heavily, dramatically, and expressively to fully fit the requested style. Use strong tone markers and creative expressions.";
      }

      const temps = { 1: 0.35, 2: 0.6, 3: 0.95 };
      const config = {
        systemPrompt,
        temperature: temps[currentIntensity] || 0.6,
        topK: currentIntensity === 1 ? 20 : (currentIntensity === 3 ? 60 : 40),
        expectedOutputLanguages: ['en']
      };

      if (typeof lm.availability === 'function') {
        const status = await lm.availability({ expectedOutputLanguages: ['en'] });
        console.log(`${TAG} availability() → "${status}"`);
        if (status === 'no' || status === 'unavailable') {
          sessionInitializing = false;
          post('AI_STATUS', { available: false, error: `Model status: ${status}` });
          return;
        }
      } else if (typeof lm.capabilities === 'function') {
        const caps = await lm.capabilities();
        console.log(`${TAG} capabilities() → "${caps.available}"`);
        if (caps.available === 'no') {
          sessionInitializing = false;
          post('AI_STATUS', { available: false, error: 'Model not available' });
          return;
        }
      }

      console.log(`${TAG} Creating session for mood: "${moodKey}"...`);
      session = await lm.create(config);
      console.log(`${TAG} ✅ Session ready`);
      sessionInitializing = false;
      post('AI_STATUS', { available: true, mood: moodKey });
      drainQueue();
    } catch (err) {
      console.error(`${TAG} Session creation failed:`, err);
      sessionInitializing = false;
      post('AI_STATUS', { available: false, error: err.message });
    }
  }

  // ── Command session (separate, on-demand) ─────────────────────────────────
  async function getCommandSession() {
    if (commandSession) return commandSession;

    const lm = getAPI();
    if (!lm) return null;

    try {
      commandSession = await lm.create({
        systemPrompt: COMMAND_SYSTEM_PROMPT,
        temperature: 0.5,
        topK: 40,
        expectedOutputLanguages: ['en']
      });
      console.log(`${TAG} ✅ Command session ready`);
      return commandSession;
    } catch (err) {
      console.error(`${TAG} Command session creation failed:`, err);
      return null;
    }
  }

  // ── Queue processor — 3-concurrent ─────────────────────────────────────────
  function enqueueRephrase(requestId, text) {
    requestQueue.push({ requestId, text, type: 'rephrase' });
    drainQueue();
  }

  function enqueueCommand(requestId, text, commandText) {
    requestQueue.push({ requestId, text, commandText, type: 'command' });
    drainQueue();
  }

  function drainQueue() {
    if (sessionInitializing) return;

    const limit = (session && cloningSupported && typeof session.clone === 'function') ? MAX_CONCURRENT : 1;
    while (requestQueue.length > 0 && activeCount < limit) {
      if (requestQueue[0].type === 'rephrase' && !session) {
        break;
      }
      const item = requestQueue.shift();
      activeCount++;
      runItem(item);
    }
  }

  async function runItem(item) {
    try {
      if (item.type === 'command') {
        await handleCommand(item.requestId, item.text, item.commandText);
      } else {
        await handleRephrase(item.requestId, item.text);
      }
    } catch (err) {
      console.error(`${TAG} Error processing ${item.requestId}:`, err);
    }
    activeCount--;
    drainQueue(); // pick up next item immediately
  }

  // ── Streaming helper ──────────────────────────────────────────────────────
  async function streamPrompt(activeSession, prompt, requestId, typePrefix, baseSessionToCheck) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('AI Request Timeout')), 15000);
    });

    try {
      await Promise.race([
        streamPromptInternal(activeSession, prompt, requestId, typePrefix, baseSessionToCheck),
        timeoutPromise
      ]);
    } catch (err) {
      console.warn(`${TAG} Request failed or timed out for ${requestId}:`, err.message);
      post(`${typePrefix}_FAIL`, { requestId, error: err.message });
    } finally {
      clearTimeout(timer);
    }
  }

  async function streamPromptInternal(activeSession, prompt, requestId, typePrefix, baseSessionToCheck) {
    console.log(`${TAG} [streamPrompt] Starting ${typePrefix} for ${requestId}. baseSessionToCheck=${!!baseSessionToCheck}`);
    const options = { expectedOutputLanguages: ['en'] };
    if (typeof activeSession.promptStreaming === 'function') {
      try {
        console.log(`${TAG} [streamPrompt] Calling promptStreaming for ${requestId}...`);
        const stream = activeSession.promptStreaming(prompt, options);
        let accumulatedText = '';
        let lastText = '';

        console.log(`${TAG} [streamPrompt] Iterating stream for ${requestId}...`);
        for await (const chunk of stream) {
          console.log(`${TAG} [streamPrompt] Chunk received for ${requestId}:`, chunk);
          if (baseSessionToCheck && session !== baseSessionToCheck) {
            console.log(`${TAG} [streamPrompt] Session changed during streaming for ${requestId}`);
            post(`${typePrefix}_FAIL`, { requestId, error: 'Session changed' });
            return;
          }

          const currentStr = typeof chunk === 'string' ? chunk : String(chunk);
          if (accumulatedText === '') {
            accumulatedText = currentStr;
          } else if (currentStr === accumulatedText) {
            // ignore duplicate
          } else if (currentStr.startsWith(accumulatedText)) {
            accumulatedText = currentStr;
          } else {
            accumulatedText += currentStr;
          }

          const t = accumulatedText.trim();
          if (t && t !== lastText) {
            lastText = t;
            post(`${typePrefix}_STREAM`, { requestId, text: t });
          }
        }

        console.log(`${TAG} [streamPrompt] Stream completed for ${requestId}. lastText len: ${lastText.length}`);
        if (baseSessionToCheck && session !== baseSessionToCheck) return;

        if (lastText && lastText.length > 1) {
          post(`${typePrefix}_DONE`, { requestId, text: lastText });
        } else {
          post(`${typePrefix}_FAIL`, { requestId, error: 'Stream empty' });
        }
        return;
      } catch (err) {
        if (baseSessionToCheck && session !== baseSessionToCheck) return;
        console.warn(`${TAG} [streamPrompt] Streaming failed for ${requestId}, trying fallback:`, err.message);
      }
    }

    // Fallback to non-streaming
    console.log(`${TAG} [streamPrompt] Falling back to prompt() for ${requestId}...`);
    try {
      const result = await activeSession.prompt(prompt, options);
      console.log(`${TAG} [streamPrompt] Fallback prompt() succeeded for ${requestId}:`, result);
      if (baseSessionToCheck && session !== baseSessionToCheck) return;
      const trimmed = result?.trim();
      if (trimmed && trimmed.length > 1) {
        post(`${typePrefix}_DONE`, { requestId, text: trimmed });
      } else {
        post(`${typePrefix}_FAIL`, { requestId, error: 'Bad result' });
      }
    } catch (err) {
      console.error(`${TAG} [streamPrompt] Fallback prompt() failed for ${requestId}:`, err.message);
      if (baseSessionToCheck && session !== baseSessionToCheck) return;
      post(`${typePrefix}_FAIL`, { requestId, error: err.message });
    }
  }

  // ── Rephrase handler ──────────────────────────────────────────────────────
  async function handleRephrase(requestId, text) {
    if (!session) {
      post('REPHRASE_FAIL', { requestId, error: 'No session' });
      return;
    }

    const currentSession = session;
    const sysPrompt = currentCustomPrompt || MOOD_PROMPTS[currentMood] || MOOD_PROMPTS.standard;
    const prompt = `${sysPrompt}\n\nRewrite this text applying the style above. STRICT RULES: same number of words (±2), same sentence count, no added sentences, no preamble, no quotes, no commentary. Output ONLY the rewritten text:\n\n${text}`;

    let activeSession = currentSession;
    let isCloned = false;
    if (cloningSupported && typeof currentSession.clone === 'function') {
      try {
        activeSession = await currentSession.clone();
        isCloned = true;
      } catch (err) {
        console.warn(`${TAG} Failed to clone session, falling back to base session and disabling cloning:`, err);
        cloningSupported = false;
      }
    }

    try {
      await streamPrompt(activeSession, prompt, requestId, 'REPHRASE', currentSession);
    } finally {
      if (isCloned) {
        try { activeSession.destroy(); } catch (_) {}
      }
    }
  }

  // ── Command handler ───────────────────────────────────────────────────────
  async function handleCommand(requestId, text, commandText) {
    const cmdSession = await getCommandSession();
    if (!cmdSession) {
      post('COMMAND_FAIL', { requestId, error: 'No command session' });
      return;
    }

    const prompt = `Command: ${commandText}\nOriginal Text: "${text}"\nOutput ONLY the transformed text. Do not add commentary:`;

    let activeSession = cmdSession;
    let isCloned = false;
    if (cloningSupported && typeof cmdSession.clone === 'function') {
      try {
        activeSession = await cmdSession.clone();
        isCloned = true;
      } catch (err) {
        console.warn(`${TAG} Failed to clone command session, falling back to base and disabling cloning:`, err);
        cloningSupported = false;
      }
    }

    try {
      await streamPrompt(activeSession, prompt, requestId, 'COMMAND', null);
    } finally {
      if (isCloned) {
        try { activeSession.destroy(); } catch (_) {}
      }
    }
  }

  // ── PostMessage helpers ───────────────────────────────────────────────────
  function post(type, data) {
    window.postMessage({ channel: CHANNEL, direction: 'TO_ISOLATED', type, ...data }, '*');
  }

  // ── Message listener ──────────────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || msg.channel !== CHANNEL || msg.direction !== 'TO_MAIN') return;

    switch (msg.type) {
      case 'INIT_SESSION':
        console.log(`${TAG} → INIT_SESSION (${msg.mood}, intensity: ${msg.intensity})`);
        createSession(msg.mood, msg.customPrompt || null, msg.intensity || 2);
        break;

      case 'REPHRASE_REQUEST':
        enqueueRephrase(msg.requestId, msg.text);
        break;

      case 'COMMAND_REQUEST':
        console.log(`${TAG} → COMMAND_REQUEST (${msg.requestId}): "${msg.commandText}"`);
        enqueueCommand(msg.requestId, msg.text, msg.commandText);
        break;

      case 'DESTROY_SESSION':
        console.log(`${TAG} → DESTROY_SESSION`);
        requestQueue.length = 0;
        activeCount = 0;
        sessionInitializing = false;
        if (session) {
          try { session.destroy(); } catch (_) {}
          session = null;
        }
        break;

      case 'DESTROY_COMMAND_SESSION':
        if (commandSession) {
          try { commandSession.destroy(); } catch (_) {}
          commandSession = null;
        }
        break;

      case 'PING':
        post('PONG', { hasAI: !!getAPI() });
        break;
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  const hasAI = !!getAPI();
  console.log(`${TAG} Bridge loaded — AI present: ${hasAI}`);
  post('BRIDGE_READY', { hasAI });
})();
