import { ULTRA_COMMITMENT, formatDuration, formatUsage, humanDateTime } from "./utils.js";

const $ = (selector) => document.querySelector(selector);
const els = {
  statusPill: $("#statusPill"),
  extensionToggle: $("#extensionToggle"),
  modeSummary: $("#modeSummary"),
  simpleDailyMinutes: $("#simpleDailyMinutes"),
  saveSimpleLimit: $("#saveSimpleLimit"),
  simpleUsageNote: $("#simpleUsageNote"),
  ultraSetup: $("#ultraSetup"),
  ultraDuration: $("#ultraDuration"),
  ultraUnit: $("#ultraUnit"),
  ultraCommitment: $("#ultraCommitment"),
  startUltra: $("#startUltra"),
  ultraRunning: $("#ultraRunning"),
  ultraDetails: $("#ultraDetails"),
  ultraBreak: $("#ultraBreak"),
  ultraBreakNote: $("#ultraBreakNote"),
  blocklistText: $("#blocklistText"),
  listCount: $("#listCount"),
  saveBlocklist: $("#saveBlocklist"),
  listLock: $("#listLock"),
  ruleErrors: $("#ruleErrors"),
  usageRange: $("#usageRange"),
  usageChart: $("#usageChart"),
  usageTotal: $("#usageTotal"),
  resetUsage: $("#resetUsage"),
  hideYouTubeShorts: $("#hideYouTubeShorts"),
  message: $("#message")
};

let status;
let usage;
let blocklistDirty = false;
let simpleLimitDirty = false;
let tickCount = 0;
let ultraDurationUnit = els.ultraUnit.value;

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Extension request failed.");
  return response.data;
}

function showMessage(text, kind = "") {
  els.message.textContent = text;
  els.message.className = `notice floating ${kind}`.trim();
  window.clearTimeout(showMessage.timer);
  showMessage.timer = window.setTimeout(() => els.message.classList.add("hidden"), 4500);
}

function renderStatus() {
  if (!status) return;
  const { settings, now, ultraActive, blockingActive, ultraBreakAvailable, ultraBreakInProgress } = status;
  const liveRemainingMs = Math.max(0, status.simpleRemainingMs);

  els.statusPill.className = "status-pill";
  if (ultraActive) {
    els.statusPill.textContent = ultraBreakInProgress ? "Ultra break" : "Ultra locked";
    els.statusPill.classList.add(ultraBreakInProgress ? "available" : "ultra");
    els.modeSummary.textContent = `Ultra mode ends ${humanDateTime(settings.ultraEndAt)} (${formatDuration(settings.ultraEndAt - now)} remaining).`;
  } else if (!settings.extensionEnabled) {
    els.statusPill.textContent = "Disabled";
    els.statusPill.classList.add("off");
    els.modeSummary.textContent = "Blinkers is disabled.";
  } else if (blockingActive) {
    els.statusPill.textContent = "Limit reached";
    els.statusPill.classList.add("active");
    els.modeSummary.textContent = "Sites on the blocklist are blocked for today.";
  } else {
    els.statusPill.textContent = "Time available";
    els.statusPill.classList.add("available");
    els.modeSummary.textContent = `${formatDuration(liveRemainingMs)} left for sites on the blocklist.`;
  }

  els.extensionToggle.checked = Boolean(settings.extensionEnabled);
  els.extensionToggle.disabled = ultraActive;
  els.simpleDailyMinutes.disabled = ultraActive;
  els.saveSimpleLimit.disabled = ultraActive;
  if (!simpleLimitDirty) els.simpleDailyMinutes.value = String(settings.simpleDailyLimitMinutes);
  els.simpleUsageNote.textContent = `${formatDuration(liveRemainingMs)} left today · ${formatUsage(status.simpleUsedMs)} used`;
  els.hideYouTubeShorts.checked = Boolean(settings.hideYouTubeShorts);
  els.hideYouTubeShorts.disabled = ultraActive;

  els.ultraSetup.classList.toggle("hidden", ultraActive);
  els.ultraRunning.classList.toggle("hidden", !ultraActive);
  if (ultraActive) {
    const breakAllowed = Boolean(settings.ultraBreakAllowed);
    els.ultraBreak.classList.toggle("hidden", !breakAllowed);
    els.ultraBreakNote.classList.toggle("hidden", !breakAllowed);
    els.ultraDetails.textContent = ultraBreakInProgress
      ? `Break active. Blocking resumes in ${formatDuration(settings.ultraBreakUntil - now)}.`
      : `Locked until ${humanDateTime(settings.ultraEndAt)}.`;
    if (breakAllowed) {
      els.ultraBreak.disabled = !ultraBreakAvailable;
      if (ultraBreakInProgress) {
        els.ultraBreak.textContent = `Break: ${formatDuration(settings.ultraBreakUntil - now)} left`;
        els.ultraBreakNote.textContent = `Next break after ${humanDateTime(settings.ultraCooldownUntil)}.`;
      } else if (settings.ultraCooldownUntil > now) {
        els.ultraBreak.textContent = "5-minute break unavailable";
        els.ultraBreakNote.textContent = `Available ${humanDateTime(settings.ultraCooldownUntil)}.`;
      } else {
        els.ultraBreak.textContent = "Use 5-minute break";
        els.ultraBreakNote.textContent = "Blocking resumes automatically after five minutes.";
      }
    }
  }

  const locked = ultraActive;
  els.blocklistText.disabled = locked;
  els.saveBlocklist.disabled = locked;
  els.listLock.classList.toggle("hidden", !locked);
  els.listLock.textContent = locked ? "The blocklist is locked until Ultra mode finishes." : "";

  els.listCount.textContent = `${settings.blocklist.length} ${settings.blocklist.length === 1 ? "entry" : "entries"}`;
  if (!blocklistDirty) {
    els.blocklistText.value = settings.blocklist.join("\n");
  }

  els.ruleErrors.classList.toggle("hidden", !settings.lastRuleError);
  els.ruleErrors.textContent = settings.lastRuleError ? `Some entries could not be activated:\n${settings.lastRuleError}` : "";
}

function renderChart() {
  els.usageChart.replaceChildren();
  if (!usage?.top?.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No tracked browsing time yet.";
    els.usageChart.append(empty);
    els.usageTotal.textContent = "";
    return;
  }

  const max = usage.top[0].ms || 1;
  for (const item of usage.top) {
    const row = document.createElement("div");
    row.className = "chart-row";
    const label = document.createElement("div");
    label.className = "chart-label";
    label.textContent = item.domain;
    label.title = item.domain;
    const track = document.createElement("div");
    track.className = "chart-track";
    const bar = document.createElement("div");
    bar.className = "chart-bar";
    bar.style.width = `${Math.max(2, (item.ms / max) * 100)}%`;
    track.append(bar);
    const value = document.createElement("div");
    value.className = "chart-value";
    value.textContent = formatUsage(item.ms);
    row.append(label, track, value);
    els.usageChart.append(row);
  }
  els.usageTotal.textContent = `Top-site total: ${formatUsage(usage.totalMs)}`;
}

async function refreshUsage() {
  usage = await send("getUsage", { days: Number(els.usageRange.value) });
  renderChart();
}

async function refreshAll() {
  try {
    const dashboard = await send("getDashboard", { days: Number(els.usageRange.value) });
    status = dashboard.status;
    usage = dashboard.usage;
    renderStatus();
    renderChart();
  } catch (error) {
    showMessage(error.message, "error");
  }
}

els.extensionToggle.addEventListener("change", async () => {
  try {
    status = await send("setExtensionEnabled", { enabled: els.extensionToggle.checked });
    renderStatus();
    showMessage(els.extensionToggle.checked ? "Blinkers enabled." : "Blinkers disabled.", "success");
  } catch (error) {
    els.extensionToggle.checked = Boolean(status?.settings?.extensionEnabled);
    showMessage(error.message, "error");
  }
});

els.ultraBreak.addEventListener("click", async () => {
  try {
    status = await send("startUltraBreak");
    renderStatus();
  } catch (error) {
    showMessage(error.message, "error");
  }
});
els.saveSimpleLimit.addEventListener("click", async () => {
  if (!els.simpleDailyMinutes.reportValidity()) return;
  try {
    status = await send("setSimpleDailyLimit", { minutes: Number(els.simpleDailyMinutes.value) });
    simpleLimitDirty = false;
    renderStatus();
    showMessage("Daily limit saved.", "success");
  } catch (error) {
    showMessage(error.message, "error");
    renderStatus();
  }
});

els.simpleDailyMinutes.addEventListener("input", () => { simpleLimitDirty = true; });

function updateUltraDurationUnit() {
  const nextUnit = els.ultraUnit.value;
  const value = Number(els.ultraDuration.value);
  if (nextUnit !== ultraDurationUnit && Number.isFinite(value)) {
    const converted = nextUnit === "hours" ? value / 60 : value * 60;
    els.ultraDuration.value = String(Number(converted.toFixed(2)));
  }
  ultraDurationUnit = nextUnit;
  const hours = nextUnit === "hours";
  els.ultraDuration.min = hours ? "0.25" : "15";
  els.ultraDuration.max = hours ? "168" : "10080";
  els.ultraDuration.step = hours ? "0.25" : "15";
}

els.ultraUnit.addEventListener("change", updateUltraDurationUnit);

els.startUltra.addEventListener("click", async () => {
  if (!els.ultraDuration.reportValidity()) return;
  const raw = Number(els.ultraDuration.value);
  const durationMinutes = els.ultraUnit.value === "hours" ? raw * 60 : raw;
  try {
    status = await send("startUltra", {
      durationMinutes,
      commitmentText: els.ultraCommitment.value
    });
    els.ultraCommitment.value = "";
    renderStatus();
    showMessage("Ultra mode started. The controls are now locked.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});

els.saveBlocklist.addEventListener("click", async () => {
  const patterns = els.blocklistText.value.split(/\r?\n/);
  try {
    status = await send("replacePatterns", { patterns });
    blocklistDirty = false;
    renderStatus();
    showMessage("Blocklist saved.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});

els.blocklistText.addEventListener("input", () => { blocklistDirty = true; });

els.hideYouTubeShorts.addEventListener("change", async () => {
  try {
    status = await send("setHideYouTubeShorts", { enabled: els.hideYouTubeShorts.checked });
    renderStatus();
    showMessage(els.hideYouTubeShorts.checked ? "YouTube Shorts disabled." : "YouTube Shorts enabled.", "success");
  } catch (error) {
    els.hideYouTubeShorts.checked = Boolean(status?.settings?.hideYouTubeShorts);
    showMessage(error.message, "error");
  }
});

els.usageRange.addEventListener("change", () => void refreshUsage().catch((error) => showMessage(error.message, "error")));
els.resetUsage.addEventListener("click", async () => {
  const confirmed = window.confirm("Reset all locally stored website time totals?");
  if (!confirmed) return;
  try {
    await send("resetUsage");
    await refreshUsage();
    showMessage("Time data reset.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});

els.ultraCommitment.placeholder = ULTRA_COMMITMENT;
window.setInterval(() => {
  if (status) {
    const now = Date.now();
    if (status.simpleTracking) {
      status.simpleRemainingMs = Math.max(0, status.simpleRemainingMs - Math.max(0, now - status.now));
    }
    status.now = now;
    renderStatus();
    tickCount += 1;
    if (tickCount % 10 === 0) {
      void send("getStatus").then((nextStatus) => {
        status = nextStatus;
        renderStatus();
      }).catch(() => {});
    }
  }
}, 1000);

void refreshAll();
