// Service worker: owns capture stream IDs and the offscreen document, applies
// the effective gain for a domain (site setting + quiet-hours + whitelist),
// and re-sweeps tabs when the schedule window opens or closes.
//
// MV3 note: tabCapture's MediaStream can't live in a service worker, so the
// worker only mints a streamId via getMediaStreamId() and forwards it to an
// offscreen document, which builds the Web Audio graph.

importScripts("storage.js");

const OFFSCREEN_PATH = "offscreen.html";

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

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Route captured tab audio through a gain node to lower its volume.",
    });
  } catch (e) {
    if (!String(e).includes("Only a single offscreen")) throw e;
  }
}

// Apply a target gain (and normalize flag) to one tab. gain >= 1 with no
// normalization tears the capture down; otherwise we start/update the graph.
async function applyToTab(tabId, gain, normalize) {
  if (typeof tabId !== "number") {
    return { ok: false, error: "No tab to capture." };
  }

  if (gain >= 1 && !normalize) {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: "offscreen", type: "stop", tabId });
    return { ok: true };
  }

  await ensureOffscreen();

  // Reuse a live capture if one exists — re-capturing doubles the audio.
  const updated = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "setGain",
    tabId,
    gain,
    normalize,
  });
  if (updated && updated.ok) return updated;

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    return { ok: false, error: "This tab can't be captured right now." };
  }

  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start",
    tabId,
    streamId,
    gain,
    normalize,
  });
  return res || { ok: true };
}

// Resolve the effective gain for a tab's domain and apply it.
async function applyForDomain(tabId, domain) {
  const [site, settings] = await Promise.all([QT.getSite(domain), QT.getSettings()]);
  const gain = QT.effectiveGain(domain, site, settings);
  const normalize = !!(site && site.normalize) && !QT.isWhitelisted(settings, domain);
  return applyToTab(tabId, gain, normalize);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  // Popup asks us to apply a specific gain immediately (live slider drag).
  if (msg.type === "applyGain") {
    applyToTab(msg.tabId, msg.gain, !!msg.normalize)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // Popup changed settings (schedule/whitelist/pro) -> re-sweep all tabs.
  if (msg.type === "resweep") {
    sweepAllTabs()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  return false;
});

// Auto-apply on tab load.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const domain = domainFromUrl(tab.url);
  if (!domain) return;
  try {
    await applyForDomain(tabId, domain);
  } catch {
    // Tab may have navigated away.
  }
});

// Re-apply across every audible/open tab. Used after settings changes and on
// schedule-boundary alarms.
async function sweepAllTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const domain = domainFromUrl(tab.url);
    if (!domain || typeof tab.id !== "number") continue;
    try {
      await applyForDomain(tab.id, domain);
    } catch {
      // Ignore tabs that can't be captured.
    }
  }
}

// --- Quiet-hours scheduling -------------------------------------------------
// We can't wake exactly at the window edge cheaply, so we poll once a minute
// with an alarm and re-sweep whenever the active state flips.

let lastScheduleActive = null;

async function onScheduleTick() {
  const settings = await QT.getSettings();
  const active = QT.scheduleActive(settings.schedule);
  if (active !== lastScheduleActive) {
    lastScheduleActive = active;
    await sweepAllTabs();
  }
}

chrome.alarms.create("qt-schedule", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "qt-schedule") onScheduleTick();
});

chrome.runtime.onInstalled.addListener(async () => {
  await QT.migrate();
  chrome.alarms.create("qt-schedule", { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("qt-schedule", { periodInMinutes: 1 });
});
