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

## Stretch features (built)

All three stretch features plus the monetization gate are in. Global settings live in the **Settings** page (toolbar icon → Settings).

- **Loudness leveling** — a per-site toggle. Routes audio through a `DynamicsCompressorNode` plus an RMS-measuring `AnalyserNode` that eases a makeup gain toward a target level, so loud and quiet passages land closer together. This is practical loudness leveling, *not* certified ITU-R BS.1770 LUFS — labeled honestly in the UI.
- **Quiet hours** — a time window (wraps past midnight, e.g. 22:00→07:00) that caps every captured tab at or below a chosen level, on top of per-site settings. A once-a-minute alarm re-sweeps open tabs when the window opens or closes.
- **Whitelist** — domains that are never auto-reduced (music sites). Subdomains match automatically.
- **Free / Pro gate** — free plan covers 3 configured sites; Pro removes the cap. The popup shows usage and blocks a 4th site on the free plan. The Pro toggle is a local dev stand-in — **wire it to a real license check before shipping.**

### Storage model (`storage.js`, shared by all contexts)

```
sites:    { [domain]: { gain, normalize } }
settings: { pro, schedule: { enabled, start, end, gain }, whitelist: [] }
```

`effectiveGain(domain, site, settings, now)` resolves what actually plays: whitelist → gain 1; otherwise the site gain, further lowered to the quiet-hours cap when the window is active. A one-time `migrate()` folds the v0.1 flat `{domain: number}` keys into `sites` on install.

### Tests

`storage.js`'s pure logic (schedule wrap-around, effective gain, whitelist, gate, migration) has a Node test harness — run it with the snippet in the commit history, 17 assertions.

## Permissions rationale

- `tabCapture` — capture tab audio to route through the gain node.
- `storage` — persist per-site and global settings (synced).
- `offscreen` — host the Web Audio graph (MV3 workers can't).
- `tabs` — read `tab.url` across tabs for auto-apply and schedule re-sweeps.
- `alarms` — the once-a-minute quiet-hours boundary check.
