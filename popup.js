// popup.js
document.addEventListener("DOMContentLoaded", () => {
  const activeState = document.getElementById("active-state");
  const errorState = document.getElementById("error-state");
  const btnRecheck = document.getElementById("btn-recheck");
  const statusPill = document.getElementById("status-pill");

  // ── Tab switching ──
  const tabs = document.querySelectorAll(".mt-tab");
  const panels = document.querySelectorAll(".mt-panel");

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      panels.forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      const targetPanel = document.getElementById("panel-" + tab.dataset.tab);
      if (targetPanel) targetPanel.classList.add("active");
    });
  });

  // ── Status check ──
  function checkStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "GET_AI_STATUS" }, (response) => {
          if (chrome.runtime.lastError || !response) {
            checkStorageFallback();
            return;
          }
          renderState(response.available);
        });
      } else {
        checkStorageFallback();
      }
    });
  }

  function checkStorageFallback() {
    chrome.storage.local.get(["aiAvailable"], (data) => {
      const isAvailable = data.aiAvailable === true;
      renderState(isAvailable);
    });
  }

  function renderState(isAvailable) {
    if (isAvailable) {
      activeState.style.display = "block";
      errorState.style.display = "none";
      statusPill.textContent = "Active";
      statusPill.className = "mt-status-pill active";
    } else {
      activeState.style.display = "none";
      errorState.style.display = "block";
      statusPill.textContent = "Setup Needed";
      statusPill.className = "mt-status-pill error";
    }
  }

  btnRecheck.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "TRIGGER_MODEL_UPDATE" }, () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id && !tabs[0].url.startsWith("chrome://")) {
          chrome.tabs.reload(tabs[0].id);
        }
        setTimeout(() => window.close(), 200);
      });
    });
  });

  checkStatus();

  // ── Show floating button toggle ──
  const toggleFloatingBtn = document.getElementById("toggle-floating-btn");
  if (toggleFloatingBtn) {
    chrome.storage.local.get(["hideFloatingBtn"], (res) => {
      toggleFloatingBtn.checked = !res.hideFloatingBtn; // true = show, false = hide
    });
    toggleFloatingBtn.addEventListener("change", (e) => {
      const show = e.target.checked;
      const hide = !show;
      chrome.storage.local.set({ hideFloatingBtn: hide });
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id && !tabs[0].url.startsWith("chrome://")) {
           chrome.tabs.sendMessage(tabs[0].id, { type: "UPDATE_FLOATING_BTN", hide: hide }).catch(() => {});
        }
      });
    });
  }
});
