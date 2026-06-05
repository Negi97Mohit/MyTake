# Privacy Policy — MyTake

**Effective date:** 2025-06-01
**Extension:** MyTake (Chrome Web Store)
**Developer:** Mohit Singh Negi

---

## 1. Overview

MyTake is a Chrome browser extension that rephrases the visible text of any webpage in a chosen tone or mood using **Chrome's built-in, on-device Gemini Nano AI** (the Prompt API). All AI inference runs locally inside your browser. No text, browsing data, or personal information is ever sent to any external server — including any server operated by the developer.

---

## 2. Data We Do Not Collect

MyTake does **not** collect, transmit, store remotely, or sell:

- The content of any webpage you visit
- Any text that is rephrased by the AI
- Your browsing history or tab URLs
- Any personally identifiable information (name, email, IP address, etc.)
- Cookies or device fingerprints
- Crash reports or analytics events

---

## 3. Data Stored Locally (on Your Device Only)

The following data is stored exclusively in `chrome.storage.local`, which is scoped to your browser profile and never transmitted externally:

| Data | Purpose | Max Size |
|---|---|---|
| `mood` | Your currently selected tone | ~20 bytes |
| `mode` | Auto or manual rewrite mode | ~10 bytes |
| `intensity` | Rephrasing intensity (1–3) | ~10 bytes |
| `theme` | UI theme preference (dark/light) | ~10 bytes |
| `enabled` / `paused` | Extension on/off state | ~10 bytes |
| `custom_moods` | User-created mood presets | Variable |
| `saved_commands` | User-saved AI command shortcuts | Variable |
| `mytake_cache` | Cached AI rephrasings (up to 2,000 entries) | ≤ ~1 MB |

The rephrasing cache stores original text snippets alongside their AI-rephrased equivalents **locally** to avoid redundant processing. This cache is never read by the developer and never leaves your machine. You can clear it at any time by clearing the extension's storage via `chrome://extensions`.

---

## 4. AI Processing

All AI inference is performed by **Chrome's built-in Gemini Nano model** running directly on your device via the experimental `window.LanguageModel` / Prompt API. Text sent to the model for rephrasing:

- Never leaves your device
- Is not processed by any cloud AI service
- Is not logged or observed by the developer
- Is discarded by the model session when you navigate away or close the tab

MyTake does not integrate with any third-party AI API (OpenAI, Anthropic, Google Cloud AI, etc.).

---

## 5. Permissions Explained

| Permission | Why It Is Required |
|---|---|
| `host_permissions: <all_urls>` | Required to inject content scripts into whichever webpage you choose to rephrase. MyTake reads DOM text nodes on the active page to send them for local AI transformation. No page content is transmitted externally. |
| `scripting` | Required to inject `content.js` (isolated world) and `content-main.js` (main world) into tabs. The main-world script is necessary to access Chrome's `window.LanguageModel` API. |
| `storage` | Required to persist your mood, mode, intensity, theme, and custom presets across sessions, and to maintain the local rephrasing cache. |
| `tabs` | Required to broadcast setting changes (mood, intensity, enabled state) to all open tabs when you update them in the popup, and to target the active tab for manual rewrite triggers. Tab URLs are never read or stored. |

---

## 6. Third-Party Services

MyTake does **not** integrate with, call, or transmit data to any third-party service. The extension has no network requests of its own. The only external resource referenced is the Google Fonts stylesheet (`fonts.googleapis.com`) loaded in the popup UI for the Inter typeface, which is a standard browser CSS import and does not involve any user data.

---

## 7. Remote Code

MyTake does **not** load or execute remote code. All JavaScript (`background.js`, `content.js`, `content-main.js`, `popup.js`) is bundled statically within the extension package as distributed on the Chrome Web Store.

---

## 8. Children's Privacy

MyTake does not knowingly collect any information from anyone, including children under the age of 13. The extension has no accounts, no sign-up, and no data collection mechanism of any kind.

---

## 9. Changes to This Policy

If this privacy policy changes materially, the updated policy will be published in this repository and the Chrome Web Store listing will be updated accordingly. The effective date at the top of this document will reflect the most recent revision.

---

## 10. Contact

Questions about this privacy policy can be directed to the developer via GitHub Issues on the [MyTake repository](https://github.com/Negi97Mohit/MyTake) or via LinkedIn.
