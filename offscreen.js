// Offscreen document: holds the actual captured MediaStream and Web Audio
// graph per tab. Receives start/stop/setGain messages from the service worker.
//
// Graph per tab: MediaStreamSource -> GainNode -> AudioContext.destination
// The captured stream is muted on the original tab's output path, so without
// re-routing to destination the audio would go silent. We intentionally play
// it back through destination at the reduced gain.

// tabId -> { context, source, gain, stream }
const sessions = new Map();

function stop(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  try {
    s.stream.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    s.source.disconnect();
    s.gain.disconnect();
  } catch {}
  try {
    s.context.close();
  } catch {}
  sessions.delete(tabId);
}

async function start(tabId, streamId, gainValue) {
  // Replace any existing session for this tab.
  stop(tabId);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch (e) {
    return { ok: false, error: "Capture permission denied for this tab." };
  }

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const gain = context.createGain();
  gain.gain.value = gainValue;

  source.connect(gain);
  gain.connect(context.destination);

  // If the tab stops producing audio (navigation/close), clean up.
  stream.getAudioTracks().forEach((track) => {
    track.addEventListener("ended", () => stop(tabId));
  });

  sessions.set(tabId, { context, source, gain, stream });
  return { ok: true };
}

function setGain(tabId, gainValue) {
  const s = sessions.get(tabId);
  if (!s) return { ok: false, error: "No active capture for this tab." };
  s.gain.gain.value = gainValue;
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;

  if (msg.type === "start") {
    start(msg.tabId, msg.streamId, msg.gain)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "setGain") {
    sendResponse(setGain(msg.tabId, msg.gain));
    return false;
  }

  if (msg.type === "stop") {
    stop(msg.tabId);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
