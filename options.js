// Options page: plan toggle, quiet-hours schedule, and whitelist. Saving
// writes settings and asks the worker to re-sweep open tabs immediately.

const proEl = document.getElementById("pro");
const planStateEl = document.getElementById("planState");
const schedEnabledEl = document.getElementById("schedEnabled");
const schedStartEl = document.getElementById("schedStart");
const schedEndEl = document.getElementById("schedEnd");
const schedGainEl = document.getElementById("schedGain");
const schedGainValEl = document.getElementById("schedGainVal");
const whitelistEl = document.getElementById("whitelist");
const saveEl = document.getElementById("save");
const savedEl = document.getElementById("saved");

function parseWhitelist(text) {
  return [...new Set(
    text
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean)
      // strip scheme/path if the user pastes a full URL
      .map((l) => l.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
  )];
}

async function load() {
  const settings = await QT.getSettings();
  const count = await QT.siteCount();

  proEl.checked = !!settings.pro;
  planStateEl.textContent = settings.pro
    ? `Pro — ${count} sites configured.`
    : `Free — ${count}/${QT.FREE_SITE_LIMIT} sites used.`;

  schedEnabledEl.checked = !!settings.schedule.enabled;
  schedStartEl.value = settings.schedule.start;
  schedEndEl.value = settings.schedule.end;
  schedGainEl.value = String(Math.round(settings.schedule.gain * 100));
  schedGainValEl.textContent = `${schedGainEl.value}%`;

  whitelistEl.value = (settings.whitelist || []).join("\n");
}

schedGainEl.addEventListener("input", () => {
  schedGainValEl.textContent = `${schedGainEl.value}%`;
});

saveEl.addEventListener("click", async () => {
  await QT.setSettings({
    pro: proEl.checked,
    schedule: {
      enabled: schedEnabledEl.checked,
      start: schedStartEl.value || "22:00",
      end: schedEndEl.value || "07:00",
      gain: Number(schedGainEl.value) / 100,
    },
    whitelist: parseWhitelist(whitelistEl.value),
  });

  try {
    await chrome.runtime.sendMessage({ type: "resweep" });
  } catch {
    // Worker may be asleep; settings still saved and applied on next load.
  }

  savedEl.hidden = false;
  setTimeout(() => (savedEl.hidden = true), 1500);
  load();
});

load();
