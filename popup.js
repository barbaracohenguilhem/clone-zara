// Popup: per-site slider + loudness-leveling toggle, gated by the free-site
// limit. Persists via the shared QT storage model and asks the worker to apply.

const sliderEl = document.getElementById("slider");
const valueEl = document.getElementById("value");
const domainEl = document.getElementById("domain");
const statusEl = document.getElementById("status");
const normalizeEl = document.getElementById("normalize");
const optionsEl = document.getElementById("options");
const planEl = document.getElementById("plan");
const proPill = document.getElementById("proPill");

let currentDomain = null;
let currentTabId = null;
let settings = null;
let saveTimer = null;

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

function setStatus(text, warn = false) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("warn", !!warn);
}

function render(percent) {
  sliderEl.value = String(percent);
  valueEl.textContent = `${percent}%`;
}

function lockUI(reason) {
  sliderEl.disabled = true;
  normalizeEl.disabled = true;
  document.body.classList.add("blocked");
  setStatus(reason, true);
}

async function refreshPlanLine() {
  const count = await QT.siteCount();
  if (settings.pro) {
    proPill.hidden = false;
    planEl.textContent = `${count} site${count === 1 ? "" : "s"} configured`;
  } else {
    planEl.textContent = `${count}/${QT.FREE_SITE_LIMIT} free sites used`;
  }
}

async function init() {
  optionsEl.addEventListener("click", () => chrome.runtime.openOptionsPage());

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await QT.getSettings();
  await refreshPlanLine();

  if (!tab) return lockUI("No active tab.");
  currentTabId = tab.id;
  currentDomain = domainFromUrl(tab.url);

  if (!currentDomain) {
    domainEl.textContent = "This page can't be adjusted";
    return lockUI("Audio capture isn't available on browser or store pages.");
  }
  domainEl.textContent = currentDomain;

  if (QT.isWhitelisted(settings, currentDomain)) {
    const site = await QT.getSite(currentDomain);
    render(site ? Math.round(site.gain * 100) : 100);
    normalizeEl.checked = !!(site && site.normalize);
    lockUI("Whitelisted — never auto-reduced. Remove it in Settings to adjust.");
    return;
  }

  const site = await QT.getSite(currentDomain);
  render(site ? Math.round(site.gain * 100) : 100);
  normalizeEl.checked = !!(site && site.normalize);

  // Enforce the free-site cap only when this would be a NEW configured site.
  const gate = await QT.canConfigure(currentDomain);
  if (!gate.allowed) {
    lockUI(gate.reason);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(applyAndSave, 120);
}

async function applyAndSave() {
  const percent = Number(sliderEl.value);
  const gain = percent / 100;
  const normalize = normalizeEl.checked;

  // Re-check the gate at save time (count may have changed in another tab).
  const existing = await QT.getSite(currentDomain);
  const isNew = !existing && (gain < 1 || normalize);
  if (isNew) {
    const gate = await QT.canConfigure(currentDomain);
    if (!gate.allowed) {
      lockUI(gate.reason);
      return;
    }
  }

  await QT.setSite(currentDomain, { gain, normalize });
  await refreshPlanLine();

  try {
    const res = await chrome.runtime.sendMessage({
      type: "applyGain",
      tabId: currentTabId,
      domain: currentDomain,
      gain,
      normalize,
    });
    if (res && res.ok === false && res.error !== "normalize-changed") {
      setStatus(res.error || "Couldn't apply to this tab.");
    } else if (res && res.error === "normalize-changed") {
      // Topology changed — restart capture cleanly.
      await chrome.runtime.sendMessage({
        type: "applyGain", tabId: currentTabId, domain: currentDomain, gain: 1, normalize: false,
      });
      await chrome.runtime.sendMessage({
        type: "applyGain", tabId: currentTabId, domain: currentDomain, gain, normalize,
      });
      setStatus("Updated.");
    } else {
      setStatus(
        gain === 1 && !normalize ? "Volume restored." :
        normalize ? `Reducing to ${percent}%, leveling on.` :
        `Reducing to ${percent}%.`
      );
    }
  } catch {
    setStatus("Saved. Reload the tab to apply.");
  }
}

sliderEl.addEventListener("input", () => {
  valueEl.textContent = `${sliderEl.value}%`;
  scheduleSave();
});
normalizeEl.addEventListener("change", scheduleSave);

init();
