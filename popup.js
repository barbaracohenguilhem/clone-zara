// Popup: shows a slider for the active tab's domain and persists the chosen gain.

const sliderEl = document.getElementById("slider");
const valueEl = document.getElementById("value");
const domainEl = document.getElementById("domain");
const statusEl = document.getElementById("status");
const resetEl = document.getElementById("reset");

let currentDomain = null;
let currentTabId = null;
let saveTimer = null;

// Derive a stable per-site key from a tab URL. Returns null for pages we
// cannot capture (chrome://, the Web Store, extension pages, blank tabs).
function domainFromUrl(urlStr) {
  if (!urlStr) return null;
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.hostname;
}

function setStatus(text) {
  statusEl.textContent = text || "";
}

function render(percent) {
  sliderEl.value = String(percent);
  valueEl.textContent = `${percent}%`;
}

function disableUI(reason) {
  sliderEl.disabled = true;
  resetEl.disabled = true;
  document.body.classList.add("blocked");
  setStatus(reason);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    disableUI("No active tab.");
    return;
  }
  currentTabId = tab.id;
  currentDomain = domainFromUrl(tab.url);

  if (!currentDomain) {
    domainEl.textContent = "This page can't be adjusted";
    disableUI("Audio capture isn't available on browser or store pages.");
    return;
  }

  domainEl.textContent = currentDomain;

  const stored = await chrome.storage.sync.get(currentDomain);
  const gain = typeof stored[currentDomain] === "number" ? stored[currentDomain] : 1;
  render(Math.round(gain * 100));
}

// Debounce writes so dragging the slider doesn't hammer storage/messaging.
function scheduleSave(percent) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => applyAndSave(percent), 120);
}

async function applyAndSave(percent) {
  const gain = percent / 100;

  // Persist (gain of exactly 1 means "no reduction" — drop the key to keep
  // the free-tier site count honest).
  if (gain === 1) {
    await chrome.storage.sync.remove(currentDomain);
  } else {
    await chrome.storage.sync.set({ [currentDomain]: gain });
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: "applyGain",
      tabId: currentTabId,
      domain: currentDomain,
      gain,
    });
    if (res && res.ok === false) {
      setStatus(res.error || "Couldn't apply to this tab.");
    } else {
      setStatus(gain === 1 ? "Volume restored." : `Reducing to ${percent}%.`);
    }
  } catch (e) {
    setStatus("Saved. Reload the tab to apply.");
  }
}

sliderEl.addEventListener("input", () => {
  const percent = Number(sliderEl.value);
  valueEl.textContent = `${percent}%`;
  scheduleSave(percent);
});

resetEl.addEventListener("click", () => {
  render(100);
  applyAndSave(100);
});

init();
