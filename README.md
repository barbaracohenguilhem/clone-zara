# Quiet Tab — Per-Site Volume Reducer

A Chrome extension (Manifest V3) that **lowers** the volume of loud sites per domain and reapplies the setting automatically on every visit. Every "volume" extension on the store boosts; this one reduces.

## MVP features

- Popup with a 0–100% slider for the active tab's domain.
- Captures the tab's audio and routes it through a Web Audio `GainNode` with gain < 1.0.
- Persists per-domain gain in `chrome.storage.sync` (follows your Chrome profile).
- Auto-applies the saved level when you revisit the site.

## How it works (MV3 architecture)

`chrome.tabCapture` can't hold a `MediaStream` in a service worker under Manifest V3, so the work is split:

| Piece | Responsibility |
|-------|----------------|
| `popup.js` | Slider UI; writes gain to `chrome.storage.sync`; asks the worker to apply it. |
| `background.js` | Mints a capture stream ID (`tabCapture.getMediaStreamId`), manages the offscreen document, reapplies saved gain on tab load. |
| `offscreen.js` | Calls `getUserMedia` with the stream ID, builds `source → GainNode → destination`, holds one session per tab. |

Because the captured stream is re-routed through the audio graph, the offscreen document plays it back at the reduced gain. Setting a site back to 100% tears the capture down.

## Load it locally

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open a site that plays audio, click the toolbar icon, drag the slider down.

> The included icons are flat blue placeholders — swap in real artwork before publishing.

## Known limits of the MVP

- Reduction applies once a tab has finished loading; a reload may be needed on the very first install.
- One AudioContext per captured tab; the worker reuses the live gain node when you drag the slider.
- `tabCapture` won't work on `chrome://`, the Web Store, or extension pages — the popup disables itself there.

## Stretch ideas (not built yet)

- Loudness normalization toward a target LUFS.
- Quiet-hours schedule.
- Whitelist for music sites.
- Free up to 3 sites, paid for unlimited + sync (monetization).
