// Service worker: owns capture stream IDs and the offscreen document, and
// re-applies the saved gain when a tab finishes loading a known domain.
//
// MV3 note: tabCapture's MediaStream can't live in a service worker, so the
// worker only mints a streamId via getMediaStreamId() and forwards it to an
// offscreen document, which builds the Web Audio graph (source -> GainNode ->
// destination). A gain < 1 lowers volume; gain === 1 tears the capture down.

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
    // A concurrent call may have created it already; ignore that race.
    if (!String(e).includes("Only a single offscreen")) throw e;
  }
}

// Apply a gain to one tab. For gain === 1 we just tell the offscreen doc to
// stop any existing capture for that tab (no reduction needed).
async function applyGain(tabId, gain) {
  if (typeof tabId !== "number") {
    return { ok: false, error: "No tab to capture." };
  }

  if (gain >= 1) {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "stop",
      tabId,
    });
    return { ok: true };
  }

  await ensureOffscreen();

  // If a capture is already live for this tab, just adjust its gain node —
  // re-capturing would create a second AudioContext and double the audio.
  const updated = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "setGain",
    tabId,
    gain,
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
  });
  return res || { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "applyGain") {
    applyGain(msg.tabId, msg.gain)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }
  return false;
});

// Auto-apply: when a tab finishes loading a domain we have a saved gain for,
// reapply it. Capture needs a loaded page, so we wait for "complete".
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const domain = domainFromUrl(tab.url);
  if (!domain) return;

  const stored = await chrome.storage.sync.get(domain);
  const gain = stored[domain];
  if (typeof gain === "number" && gain < 1) {
    try {
      await applyGain(tabId, gain);
    } catch {
      // Tab may have navigated away; nothing to recover.
    }
  }
});
