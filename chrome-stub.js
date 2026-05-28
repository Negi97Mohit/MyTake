// chrome-stub.js — fakes chrome.* APIs so popup.html can preview in a normal browser
(function () {
  if (typeof window.chrome !== "undefined" && window.chrome.runtime) return;
  const store = {
    mood: "standard",
    enabled: true,
    mode: "manual",
    intensity: 2,
    theme: "light",
    custom_moods: [],
    saved_commands: [],
    paused: false,
  };
  const noop = () => {};
  window.chrome = {
    runtime: {
      lastError: null,
      connect: () => ({
        disconnect: noop,
        onDisconnect: { addListener: noop },
      }),
      sendMessage: (msg, cb) => {
        let res = { ok: true };
        if (msg?.type === "GET_STATE") {
          res = {
            mood: store.mood,
            enabled: store.enabled,
            mode: store.mode,
            customMoods: store.custom_moods,
            customPrompt: null,
            intensity: store.intensity,
            theme: store.theme,
            paused: store.paused,
          };
        } else if (msg?.type === "GET_COMMANDS") {
          res = { commands: store.saved_commands };
        }
        if (typeof cb === "function") setTimeout(() => cb(res), 0);
      },
      onMessage: { addListener: noop },
    },
    storage: {
      local: {
        get: (keys, cb) => cb && cb(store),
        set: (obj, cb) => {
          Object.assign(store, obj);
          cb && cb();
        },
      },
    },
  };
})();
