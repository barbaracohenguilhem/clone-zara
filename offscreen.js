// Offscreen document: holds the captured MediaStream and Web Audio graph per
// tab. Receives start/stop/setGain from the service worker.
//
// Graph per tab:
//   source -> [compressor -> levelGain]? -> userGain -> destination
//
// userGain  : the per-site slider reduction (gain < 1).
// compressor+levelGain : optional loudness leveling toward a target (the
//   "normalize" flag). A DynamicsCompressor tames peaks; an AnalyserNode
//   measures short-term RMS and we ease levelGain toward the target so quiet
//   and loud passages land closer together. This is practical loudness
//   leveling, not certified ITU-R BS.1770 LUFS.

// Target short-term level for normalization, as linear RMS (~ -20 dBFS).
const TARGET_RMS = 0.1;
const LEVEL_MIN = 0.25;
const LEVEL_MAX = 3.0;

// tabId -> session
const sessions = new Map();

function stop(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  if (s.raf) cancelAnimationFrame(s.raf);
  try {
    s.stream.getTracks().forEach((t) => t.stop());
  } catch {}
  for (const node of [s.source, s.compressor, s.levelGain, s.analyser, s.userGain]) {
    try {
      node && node.disconnect();
    } catch {}
  }
  try {
    s.context.close();
  } catch {}
  sessions.delete(tabId);
}

function buildGraph(context, source, { gain, normalize }) {
  const userGain = context.createGain();
  userGain.gain.value = gain;

  let compressor = null;
  let levelGain = null;
  let analyser = null;

  if (normalize) {
    compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 30;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.25;

    levelGain = context.createGain();
    levelGain.gain.value = 1;

    analyser = context.createAnalyser();
    analyser.fftSize = 1024;

    source.connect(compressor);
    compressor.connect(levelGain);
    levelGain.connect(analyser);
    levelGain.connect(userGain);
  } else {
    source.connect(userGain);
  }

  userGain.connect(context.destination);
  return { userGain, compressor, levelGain, analyser };
}

// Measure RMS and ease the makeup gain toward the target. Runs only while
// normalization is on for this session.
function startLeveling(s) {
  const buf = new Float32Array(s.analyser.fftSize);
  const tick = () => {
    const sess = sessions.get(s.tabId);
    if (!sess || !sess.normalize || !sess.analyser) return;
    sess.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    if (rms > 0.0005) {
      const desired = Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, TARGET_RMS / rms));
      // Ease slowly to avoid pumping.
      const cur = sess.levelGain.gain.value;
      const next = cur + (desired - cur) * 0.05;
      sess.levelGain.gain.setTargetAtTime(next, sess.context.currentTime, 0.2);
    }
    sess.raf = requestAnimationFrame(tick);
  };
  s.raf = requestAnimationFrame(tick);
}

async function start(tabId, streamId, gain, normalize) {
  stop(tabId);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
      },
      video: false,
    });
  } catch (e) {
    return { ok: false, error: "Capture permission denied for this tab." };
  }

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const nodes = buildGraph(context, source, { gain, normalize });

  const session = { tabId, context, source, stream, gain, normalize, ...nodes, raf: null };
  stream.getAudioTracks().forEach((t) => t.addEventListener("ended", () => stop(tabId)));
  sessions.set(tabId, session);

  if (normalize) startLeveling(session);
  return { ok: true };
}

// Adjust an existing session. If the normalize flag flips, the graph topology
// must change, so we signal the caller to re-start instead.
function setGain(tabId, gain, normalize) {
  const s = sessions.get(tabId);
  if (!s) return { ok: false, error: "No active capture for this tab." };
  if (!!normalize !== !!s.normalize) {
    return { ok: false, error: "normalize-changed" };
  }
  s.gain = gain;
  s.userGain.gain.setTargetAtTime(gain, s.context.currentTime, 0.02);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;

  if (msg.type === "start") {
    start(msg.tabId, msg.streamId, msg.gain, !!msg.normalize)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "setGain") {
    sendResponse(setGain(msg.tabId, msg.gain, !!msg.normalize));
    return false;
  }

  if (msg.type === "stop") {
    stop(msg.tabId);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
