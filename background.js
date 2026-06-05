// background.js — MyTake v2.0 service worker
// Stores mood, mode, custom moods, and saved commands.
// Broadcasts changes to all content scripts.

const DEFAULT_MOOD = "original";
const DEFAULT_MODE = "manual";
const DEFAULT_INTENSITY = 2;
const DEFAULT_THEME = "dark";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    mood: DEFAULT_MOOD,
    enabled: true,
    mode: DEFAULT_MODE,
    intensity: DEFAULT_INTENSITY,
    theme: DEFAULT_THEME,
    custom_moods: [],
    saved_commands: [],
    paused: false,
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    // ── State ──────────────────────────────────────────────────────
    case "GET_STATE":
      chrome.storage.local.get(
        [
          "mood",
          "enabled",
          "mode",
          "custom_moods",
          "mood_custom_prompt",
          "intensity",
          "theme",
          "paused",
        ],
        (data) => {
          sendResponse({
            mood: data.mood || DEFAULT_MOOD,
            enabled: data.enabled !== false,
            mode: data.mode || DEFAULT_MODE,
            customMoods: data.custom_moods || [],
            customPrompt: data.mood_custom_prompt || null,
            intensity: data.intensity || DEFAULT_INTENSITY,
            theme: data.theme || DEFAULT_THEME,
            paused: data.paused === true,
          });
        },
      );
      return true;

    // ── Mood ───────────────────────────────────────────────────────
    case "SET_MOOD":
      const moodData = { mood: msg.mood };
      if (msg.customPrompt) moodData.mood_custom_prompt = msg.customPrompt;
      else moodData.mood_custom_prompt = null;
      chrome.storage.local.set(moodData, () => {
        broadcastToAllTabs({
          type: "MOOD_CHANGED",
          mood: msg.mood,
          customPrompt: msg.customPrompt || null,
        });
        sendResponse({ ok: true });
      });
      return true;

    // ── Intensity ──────────────────────────────────────────────────
    case "SET_INTENSITY":
      chrome.storage.local.set({ intensity: msg.intensity }, () => {
        broadcastToAllTabs({
          type: "INTENSITY_CHANGED",
          intensity: msg.intensity,
        });
        sendResponse({ ok: true });
      });
      return true;

    // ── Theme ──────────────────────────────────────────────────────
    case "SET_THEME":
      chrome.storage.local.set({ theme: msg.theme }, () => {
        sendResponse({ ok: true });
      });
      return true;

    // ── Enable/Disable ────────────────────────────────────────────
    case "SET_ENABLED":
      chrome.storage.local.set({ enabled: msg.enabled }, () => {
        broadcastToAllTabs({ type: "ENABLED_CHANGED", enabled: msg.enabled });
        sendResponse({ ok: true });
      });
      return true;

    // ── Mode (auto/manual) ────────────────────────────────────────
    case "SET_MODE":
      chrome.storage.local.set({ mode: msg.mode }, () => {
        broadcastToAllTabs({ type: "MODE_CHANGED", mode: msg.mode });
        sendResponse({ ok: true });
      });
      return true;

    // ── Manual trigger ────────────────────────────────────────────
    case "TRIGGER_REWRITE":
      sendToActiveTab({ type: "TRIGGER_REWRITE" });
      sendResponse({ ok: true });
      return true;

    // ── Target mode ───────────────────────────────────────────────
    case "TARGET_MODE_ACTIVATE":
      sendToActiveTab({ type: "TARGET_MODE_ACTIVATE" });
      sendResponse({ ok: true });
      return true;

    case "TARGET_MODE_DEACTIVATE":
      sendToActiveTab({ type: "TARGET_MODE_DEACTIVATE" });
      sendResponse({ ok: true });
      return true;

    case "TARGET_MODE_EXITED":
      // No broadcast needed — popup receives this directly via chrome.runtime.onMessage
      sendResponse({ ok: true });
      return true;

    // ── Pause / Resume / Restart ──────────────────────────────────
    case "SET_PAUSED":
      chrome.storage.local.set({ paused: msg.paused }, () => {
        broadcastToAllTabs({ type: "PAUSED_CHANGED", paused: msg.paused });
        sendResponse({ ok: true });
      });
      return true;

    case "RESTART_REPHRASE":
      sendToActiveTab({ type: "RESTART_REPHRASE" });
      sendResponse({ ok: true });
      return true;

    // ── Commands CRUD ─────────────────────────────────────────────
    case "GET_COMMANDS":
      chrome.storage.local.get(["saved_commands"], (data) => {
        sendResponse({ commands: data.saved_commands || [] });
      });
      return true;

    case "SAVE_COMMAND":
      chrome.storage.local.get(["saved_commands"], (data) => {
        const commands = data.saved_commands || [];
        const idx = commands.findIndex((c) => c.id === msg.command.id);
        if (idx >= 0) commands[idx] = msg.command;
        else commands.push(msg.command);
        chrome.storage.local.set({ saved_commands: commands }, () => {
          sendResponse({ ok: true });
        });
      });
      return true;

    case "DELETE_COMMAND":
      chrome.storage.local.get(["saved_commands"], (data) => {
        const commands = (data.saved_commands || []).filter(
          (c) => c.id !== msg.id,
        );
        chrome.storage.local.set({ saved_commands: commands }, () => {
          sendResponse({ ok: true });
        });
      });
      return true;

    // ── Run commands on active tab ────────────────────────────────
    case "RUN_COMMAND":
      sendToActiveTab({ type: "RUN_COMMAND", commandText: msg.commandText });
      sendResponse({ ok: true });
      return true;

    case "RUN_COMMANDS":
      sendToActiveTab({ type: "RUN_COMMANDS", commands: msg.commands });
      sendResponse({ ok: true });
      return true;

    // ── Custom Moods CRUD ─────────────────────────────────────────
    case "SAVE_CUSTOM_MOOD":
      chrome.storage.local.get(["custom_moods"], (data) => {
        const moods = data.custom_moods || [];
        const idx = moods.findIndex((m) => m.id === msg.mood.id);
        if (idx >= 0) moods[idx] = msg.mood;
        else moods.push(msg.mood);
        chrome.storage.local.set({ custom_moods: moods }, () => {
          sendResponse({ ok: true });
        });
      });
      return true;

    case "DELETE_CUSTOM_MOOD":
      chrome.storage.local.get(["custom_moods"], (data) => {
        const moods = (data.custom_moods || []).filter((m) => m.id !== msg.id);
        chrome.storage.local.set({ custom_moods: moods }, () => {
          sendResponse({ ok: true });
        });
      });
      return true;

    // ── Auto-update Gemini Nano when crash-blacklisted ───────────────────
    case "TRIGGER_MODEL_UPDATE":
      triggerGeminiNanoUpdate();
      sendResponse({ ok: true });
      return true;

    default:
      return false;
  }
});

// ── Gemini Nano auto-update ──────────────────────────────────────────────
// When the model process has crashed too many times, Chrome blacklists it.
// Opening chrome://components and triggering a check resets this IF a newer
// model version is available. We open the page briefly in a background tab,
// wait for it to load, then close it — fully silent to the user.
let updateInProgress = false;

function triggerGeminiNanoUpdate() {
  if (updateInProgress) return;
  updateInProgress = true;
  console.log("[MyTake BG] Requesting Gemini Nano component update...");

  chrome.tabs.create({ url: "chrome://components", active: false }, (tab) => {
    if (!tab?.id) {
      updateInProgress = false;
      return;
    }

    // Wait for the page to fully load, then inject a click on
    // the "Check for update" button for the On Device Model component.
    // We use a short delay since chrome:// pages load fast.
    setTimeout(() => {
      chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Find the Optimization Guide On Device Model component
            const cards = document.querySelectorAll(
              '.component-card, [id^="opt"]',
            );
            for (const card of cards) {
              const text = card.textContent || "";
              if (
                text.includes("Optimization Guide On Device Model") ||
                text.includes("optimization-guide")
              ) {
                const btn = card.querySelector("button");
                if (btn) {
                  btn.click();
                  return "clicked";
                }
              }
            }
            // Fallback: click all "Check for update" buttons on the page
            let clicked = 0;
            document.querySelectorAll("button").forEach((btn) => {
              if (
                btn.textContent
                  .trim()
                  .toLowerCase()
                  .includes("check for update")
              ) {
                btn.click();
                clicked++;
              }
            });
            return clicked > 0
              ? `clicked ${clicked} buttons`
              : "no button found";
          },
        })
        .then((results) => {
          console.log(
            "[MyTake BG] Component update result:",
            results?.[0]?.result,
          );
        })
        .catch((err) => {
          console.warn(
            "[MyTake BG] Could not click update button:",
            err.message,
          );
        })
        .finally(() => {
          // Close the tab after 4s regardless of outcome
          setTimeout(() => {
            chrome.tabs.remove(tab.id).catch(() => {});
            updateInProgress = false;
          }, 4000);
        });
    }, 2000); // wait 2s for chrome://components to render
  });
}

// ── Helpers ───────────────────────────────────────────────────────
function broadcastToAllTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (
        tab.id &&
        tab.url &&
        !tab.url.startsWith("chrome://") &&
        !tab.url.startsWith("chrome-extension://")
      ) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }
  });
}

function sendToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
    }
  });
}

// ── Track popup open state ──────────────────────────────────────────
let popupPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "mytake_popup") {
    popupPort = port;
    sendToActiveTab({ type: "POPUP_STATE", open: true });

    port.onDisconnect.addListener(() => {
      popupPort = null;
      sendToActiveTab({ type: "POPUP_STATE", open: false });
    });
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs
    .sendMessage(activeInfo.tabId, {
      type: "POPUP_STATE",
      open: popupPort !== null,
    })
    .catch(() => {});
});

// ── Target Mode region memory ────────────────────────────────────────────────
// Stores which page regions have been processed with which mood.
// Key: URL + element fingerprint, Value: { mood, customPrompt, timestamp }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Note: this is a second listener — we only handle target-mode messages here
  // to keep the logic isolated. The main listener above handles everything else.

  if (msg.type === "SAVE_TARGET_REGION") {
    const key = "target_regions";
    chrome.storage.local.get([key], (data) => {
      const regions = data[key] || {};
      const pageKey = msg.pageKey; // url+fingerprint combo
      regions[pageKey] = {
        mood: msg.mood,
        customPrompt: msg.customPrompt || null,
        timestamp: Date.now(),
      };
      // Prune old regions (keep last 500 per page-session)
      const entries = Object.entries(regions);
      if (entries.length > 500) {
        const pruned = Object.fromEntries(entries.slice(-500));
        chrome.storage.local.set({ [key]: pruned }, () => sendResponse({ ok: true }));
      } else {
        chrome.storage.local.set({ [key]: regions }, () => sendResponse({ ok: true }));
      }
    });
    return true;
  }

  if (msg.type === "GET_TARGET_REGIONS") {
    chrome.storage.local.get(["target_regions"], (data) => {
      sendResponse({ regions: data.target_regions || {} });
    });
    return true;
  }

  if (msg.type === "CLEAR_TARGET_REGIONS") {
    chrome.storage.local.set({ target_regions: {} }, () => sendResponse({ ok: true }));
    return true;
  }
});
