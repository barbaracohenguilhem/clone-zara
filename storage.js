// Shared storage model for Quiet Tab. Loaded as a classic script (no modules)
// in the popup, service worker (via importScripts), and offscreen doc.
//
// Layout in chrome.storage.sync:
//   sites:    { [domain]: { gain: number<1, normalize: boolean } }
//   settings: { pro, schedule: { enabled, start, end, gain }, whitelist: [] }
//
// v0.1 stored a bare number per domain key. migrate() folds those into `sites`.

const QT = (() => {
  const FREE_SITE_LIMIT = 3;

  const DEFAULT_SETTINGS = {
    pro: false,
    // Quiet hours: during the window, force at most `gain` on captured tabs.
    schedule: { enabled: false, start: "22:00", end: "07:00", gain: 0.4 },
    // Music/known-good domains that are never auto-reduced.
    whitelist: [],
  };

  function isReservedKey(k) {
    return k === "sites" || k === "settings";
  }

  async function getSites() {
    const { sites } = await chrome.storage.sync.get("sites");
    return sites && typeof sites === "object" ? sites : {};
  }

  async function getSettings() {
    const { settings } = await chrome.storage.sync.get("settings");
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  }

  async function setSettings(patch) {
    const current = await getSettings();
    const next = { ...current, ...patch };
    await chrome.storage.sync.set({ settings: next });
    return next;
  }

  async function getSite(domain) {
    const sites = await getSites();
    return sites[domain] || null;
  }

  // Save or clear a site's config. gain >= 1 with normalize off means
  // "nothing to do" -> remove the entry so the site count stays honest.
  async function setSite(domain, { gain, normalize }) {
    const sites = await getSites();
    const g = typeof gain === "number" ? gain : (sites[domain]?.gain ?? 1);
    const n = typeof normalize === "boolean" ? normalize : (sites[domain]?.normalize ?? false);

    if (g >= 1 && !n) {
      delete sites[domain];
    } else {
      sites[domain] = { gain: g, normalize: n };
    }
    await chrome.storage.sync.set({ sites });
    return sites[domain] || null;
  }

  async function siteCount() {
    return Object.keys(await getSites()).length;
  }

  // Whether `domain` may be added as a NEW configured site under the current
  // tier. Already-configured domains are always editable.
  async function canConfigure(domain) {
    const settings = await getSettings();
    if (settings.pro) return { allowed: true };
    const sites = await getSites();
    if (domain in sites) return { allowed: true };
    if (Object.keys(sites).length < FREE_SITE_LIMIT) return { allowed: true };
    return {
      allowed: false,
      reason: `Free plan covers ${FREE_SITE_LIMIT} sites. Upgrade for unlimited.`,
    };
  }

  function isWhitelisted(settings, domain) {
    return (settings.whitelist || []).some(
      (d) => d === domain || domain.endsWith("." + d)
    );
  }

  // Is the quiet-hours window active right now? Handles windows that wrap
  // past midnight (e.g. 22:00 -> 07:00).
  function scheduleActive(schedule, now = new Date()) {
    if (!schedule || !schedule.enabled) return false;
    const mins = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = schedule.start.split(":").map(Number);
    const [eh, em] = schedule.end.split(":").map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (start === end) return false;
    return start < end ? mins >= start && mins < end : mins >= start || mins < end;
  }

  // The gain to actually apply for a domain right now, given saved site config
  // and global settings. Returns a number in (0, 1], or 1 for "no reduction".
  function effectiveGain(domain, site, settings, now = new Date()) {
    if (isWhitelisted(settings, domain)) return 1;
    let gain = site && typeof site.gain === "number" ? site.gain : 1;
    if (scheduleActive(settings.schedule, now)) {
      gain = Math.min(gain, settings.schedule.gain);
    }
    return gain;
  }

  // One-time migration from the flat v0.1 layout.
  async function migrate() {
    const all = await chrome.storage.sync.get(null);
    const flat = Object.entries(all).filter(
      ([k, v]) => !isReservedKey(k) && typeof v === "number"
    );
    if (flat.length === 0) return;

    const sites = all.sites && typeof all.sites === "object" ? all.sites : {};
    for (const [domain, gain] of flat) {
      if (!(domain in sites)) sites[domain] = { gain, normalize: false };
    }
    await chrome.storage.sync.set({ sites });
    await chrome.storage.sync.remove(flat.map(([k]) => k));
  }

  return {
    FREE_SITE_LIMIT,
    DEFAULT_SETTINGS,
    getSites,
    getSettings,
    setSettings,
    getSite,
    setSite,
    siteCount,
    canConfigure,
    isWhitelisted,
    scheduleActive,
    effectiveGain,
    migrate,
  };
})();

// Expose for service worker (importScripts) and window (popup/offscreen).
if (typeof self !== "undefined") self.QT = QT;
