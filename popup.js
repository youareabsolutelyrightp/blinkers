import { formatDuration, formatUsage, humanDateTime } from "./utils.js";
import { openInlineChallenge } from "./inline-friction.js";

function connectPopup() {
  const port = chrome.runtime.connect({ name: "blinkers-popup" });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    window.setTimeout(connectPopup, 250);
  });
}

connectPopup();
const $ = (selector) => document.querySelector(selector);
const els = {
  statusPill: $("#statusPill"),
  modeTitle: $("#modeTitle"),
  modeSubtext: $("#modeSubtext"),
  simpleAllowance: $("#simpleAllowance"),
  simpleTimeLeft: $("#simpleTimeLeft"),
  extraTimeChallenge: $("#extraTimeChallenge"),
  ultraActions: $("#ultraActions"),
  ultraBreak: $("#ultraBreak"),
  ultraBreakNote: $("#ultraBreakNote"),
  diagnosticNotice: $("#diagnosticNotice"),
  addForm: $("#addForm"),
  patternInput: $("#patternInput"),
  addCurrentSite: $("#addCurrentSite"),
  lockNote: $("#lockNote"),
  blocklist: $("#blocklist"),
  usageChart: $("#usageChart"),
  openOptions: $("#openOptions"),
  message: $("#message"),
  simpleChallenge: $("#simpleChallenge")
};

let dashboard;
let tickCount = 0;

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Extension request failed.");
  return response.data;
}

function showMessage(text, kind = "") {
  els.message.textContent = text;
  els.message.className = `notice ${kind}`.trim();
  window.clearTimeout(showMessage.timer);
  showMessage.timer = window.setTimeout(() => els.message.classList.add("hidden"), 4000);
}

function renderStatus(status) {
  const { settings, now, ultraActive, blockingActive, ultraBreakAvailable, ultraBreakInProgress } = status;
  const liveRemainingMs = Math.max(0, status.simpleRemainingMs);
  const limitReached = settings.extensionEnabled && liveRemainingMs <= 0;

  els.statusPill.className = "status-pill";
  if (ultraActive) {
    els.statusPill.textContent = ultraBreakInProgress ? "Ultra break" : "Ultra locked";
    els.statusPill.classList.add(ultraBreakInProgress ? "available" : "ultra");
    els.modeTitle.textContent = "Ultra mode";
    els.modeSubtext.textContent = `Ends ${humanDateTime(settings.ultraEndAt)} · ${formatDuration(settings.ultraEndAt - now)} left`;
    els.simpleAllowance.classList.add("hidden");
    els.ultraActions.classList.toggle("hidden", !settings.ultraBreakAllowed);
    els.ultraBreak.disabled = !ultraBreakAvailable;

    if (!settings.ultraBreakAllowed) {
      els.ultraBreakNote.textContent = "";
    } else if (ultraBreakInProgress) {
      els.ultraBreak.textContent = `Break: ${formatDuration(settings.ultraBreakUntil - now)} left`;
      els.ultraBreakNote.textContent = `Blocking resumes automatically. Next break after ${humanDateTime(settings.ultraCooldownUntil)}.`;
    } else if (settings.ultraCooldownUntil > now) {
      els.ultraBreak.textContent = "5-minute break unavailable";
      els.ultraBreakNote.textContent = `Available ${humanDateTime(settings.ultraCooldownUntil)}.`;
    } else {
      els.ultraBreak.textContent = "Use 5-minute break";
      els.ultraBreakNote.textContent = "After the break, another is locked for one hour.";
    }
  } else {
    els.statusPill.textContent = !settings.extensionEnabled ? "Disabled" : limitReached ? "Blocking" : "Time available";
    els.statusPill.classList.add(!settings.extensionEnabled ? "off" : limitReached ? "active" : "available");
    els.modeTitle.textContent = "Simple mode";
    els.modeSubtext.textContent = !settings.extensionEnabled
      ? "Enable Blinkers in full settings."
      : limitReached
        ? "Daily limit reached."
        : "Blocklisted sites are available.";
    els.simpleAllowance.classList.remove("hidden");
    els.simpleTimeLeft.textContent = formatDuration(liveRemainingMs);
    els.extraTimeChallenge.classList.toggle("hidden", !limitReached);
    els.ultraActions.classList.add("hidden");
  }

  const locked = ultraActive;
  els.patternInput.disabled = locked;
  els.addCurrentSite.disabled = locked;
  els.addForm.querySelector("button").disabled = locked;
  els.lockNote.classList.toggle("hidden", !locked);
  els.lockNote.textContent = locked ? "Blocklist edits are locked until Ultra mode finishes." : "";

  const diagnostics = status.diagnostics || {};
  const ruleShortfall = blockingActive && diagnostics.activeRuleCount < diagnostics.expectedRuleCount;
  els.diagnosticNotice.classList.toggle("hidden", !ruleShortfall && diagnostics.hostAccess !== false && !settings.lastRuleError);
  if (diagnostics.hostAccess === false) {
    els.diagnosticNotice.textContent = "Chrome site access is restricted. The backup tab guard is active, but for instant blocking set Extension details → Site access → On all sites.";
  } else if (settings.lastRuleError) {
    els.diagnosticNotice.textContent = `Some network rules were rejected. The backup tab guard is active. ${settings.lastRuleError.split("\n")[0]}`;
  } else if (ruleShortfall) {
    els.diagnosticNotice.textContent = `Only ${diagnostics.activeRuleCount} of ${diagnostics.expectedRuleCount} network rules are active. The backup tab guard is still enforcing the list.`;
  } else {
    els.diagnosticNotice.textContent = "";
  }
}

function renderBlocklist(settings, ultraActive) {
  els.blocklist.replaceChildren();
  if (!settings.blocklist.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No blocked sites yet.";
    els.blocklist.append(empty);
    return;
  }

  for (const pattern of settings.blocklist) {
    const row = document.createElement("div");
    row.className = "block-item";
    const code = document.createElement("code");
    code.textContent = pattern;
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = `Remove ${pattern}`;
    remove.disabled = ultraActive;
    remove.addEventListener("click", async () => {
      try {
        const status = await send("removePattern", { pattern });
        dashboard.status = status;
        render();
      } catch (error) {
        showMessage(error.message, "error");
      }
    });
    row.append(code, remove);
    els.blocklist.append(row);
  }
}

function renderChart(usage) {
  els.usageChart.replaceChildren();
  if (!usage.top.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No tracked browsing time yet.";
    els.usageChart.append(empty);
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
}

function render() {
  if (!dashboard) return;
  renderStatus(dashboard.status);
  renderBlocklist(dashboard.status.settings, dashboard.status.ultraActive);
  renderChart(dashboard.usage);
}

async function refresh() {
  try {
    dashboard = await send("getDashboard", { days: 1 });
    render();
  } catch (error) {
    showMessage(error.message, "error");
  }
}

els.extraTimeChallenge.addEventListener("click", async () => {
  try {
    const result = await send("requestSimpleChallenge");
    await openInlineChallenge({
      host: els.simpleChallenge,
      token: result.token,
      send,
      onCompleted: async () => {
        dashboard.status = await send("getStatus");
        render();
        showMessage("15 minutes added for today.", "success");
      }
    });
  } catch (error) {
    showMessage(error.message, "error");
  }
});

els.ultraBreak.addEventListener("click", async () => {
  try {
    dashboard.status = await send("startUltraBreak");
    render();
  } catch (error) {
    showMessage(error.message, "error");
  }
});

els.addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    dashboard.status = await send("addPattern", { pattern: els.patternInput.value });
    els.patternInput.value = "";
    render();
  } catch (error) {
    showMessage(error.message, "error");
  }
});

els.addCurrentSite.addEventListener("click", async () => {
  try {
    const pattern = await send("getCurrentSite");
    if (!pattern) throw new Error("This tab is not a normal website.");
    dashboard.status = await send("addPattern", { pattern });
    render();
  } catch (error) {
    showMessage(error.message, "error");
  }
});

els.openOptions.addEventListener("click", async () => {
  try {
    await chrome.runtime.openOptionsPage();
  } catch (error) {
    showMessage(error.message, "error");
  }
});
window.setInterval(() => {
  if (dashboard) {
    const now = Date.now();
    if (dashboard.status.simpleTracking) {
      dashboard.status.simpleRemainingMs = Math.max(
        0,
        dashboard.status.simpleRemainingMs - Math.max(0, now - dashboard.status.now)
      );
    }
    dashboard.status.now = now;
    renderStatus(dashboard.status);
    tickCount += 1;
    if (tickCount % 10 === 0) {
      void send("getStatus").then((nextStatus) => {
        dashboard.status = nextStatus;
        render();
      }).catch(() => {});
    }
  }
}, 1000);
void refresh();
