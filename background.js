import {
  DEFAULT_SETTINGS,
  MAX_BLOCKLIST_ITEMS,
  MAX_SIMPLE_DAILY_MINUTES,
  MAX_ULTRA_MINUTES,
  MIN_ULTRA_MINUTES,
  ULTRA_COMMITMENT,
  blockingIsActive,
  dateKey,
  dedupePatterns,
  hostnameFromUrl,
  isUltraActive,
  mergeSettings,
  patternToRegex,
  recentDateKeys,
  simpleDailyTotalMs,
  simpleTimeRemainingMs
} from "./utils.js";

const SETTINGS_KEY = "settings";
const USAGE_KEY = "usageByDay";
const TRACKER_KEY = "activeTracker";
const SIMPLE_CHALLENGE_KEY = "simpleTimeChallenge";
const MODE_ALARM = "mode-transition";
const TRACK_ALARM = "usage-flush";
const QUOTA_ALARM = "simple-quota";
const POPUP_PORT_NAME = "blinkers-popup";
const MAX_TRACK_SLICE_MS = 5 * 60 * 1000;
const SIMPLE_CHALLENGE_TTL_MS = 12 * 60 * 1000;
const SIMPLE_BONUS_MINUTES = 15;
const CHALLENGE_REQUIRED_MS = 30_000;
const BLOCKED_PAGE_URL = chrome.runtime.getURL("blocked.html");

let stateLock = Promise.resolve();
let trackerLock = Promise.resolve();
const popupPorts = new Set();
const patternRegexCache = new Map();

function serialize(lockName, task) {
  if (lockName === "state") {
    stateLock = stateLock.then(task, task);
    return stateLock;
  }
  trackerLock = trackerLock.then(task, task);
  return trackerLock;
}

function run(task) {
  task.catch(console.error);
}

async function readSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY]);
}

async function writeSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: mergeSettings(settings) });
}

function normalizeExpiredSettings(settings, now = Date.now()) {
  const next = mergeSettings(settings);
  let changed = false;

  if (next.mode === "ultra" && next.ultraEndAt <= now) {
    next.mode = "simple";
    next.extensionEnabled = true;
    next.ultraEndAt = 0;
    next.ultraBreakUntil = 0;
    next.ultraCooldownUntil = 0;
    next.ultraBreakAllowed = false;
    changed = true;
  }

  if (next.ultraBreakUntil > 0 && next.ultraBreakUntil <= now) {
    next.ultraBreakUntil = 0;
    changed = true;
  }

  const today = dateKey(now);
  if (next.simpleAllowanceDay !== today) {
    next.simpleAllowanceDay = today;
    next.simpleAllowanceUsedMs = 0;
    next.simpleBonusMinutes = 0;
    changed = true;
  }

  return { settings: next, changed };
}


function isNormalWebUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function isBlockedPageUrl(url) {
  return typeof url === "string" && url.startsWith(BLOCKED_PAGE_URL);
}

function urlMatchesPattern(url, pattern) {
  try {
    let regex = patternRegexCache.get(pattern);
    if (!regex) {
      if (patternRegexCache.size >= MAX_BLOCKLIST_ITEMS) {
        patternRegexCache.delete(patternRegexCache.keys().next().value);
      }
      regex = new RegExp(patternToRegex(pattern), "i");
      patternRegexCache.set(pattern, regex);
    }
    return regex.test(url);
  } catch {
    return false;
  }
}

function urlIsBlocked(url, settings, now = Date.now()) {
  if (!isNormalWebUrl(url) || isBlockedPageUrl(url) || !blockingIsActive(settings, now)) return false;
  return settings.blocklist.some((pattern) => urlMatchesPattern(url, pattern));
}

function blockedPageForUrl(url) {
  return `${BLOCKED_PAGE_URL}#encoded:${encodeURIComponent(url)}`;
}

function originalUrlFromBlockedPage(url) {
  if (!isBlockedPageUrl(url) || !url.includes("#")) return "";
  let value = url.slice(url.indexOf("#") + 1);
  if (value.startsWith("encoded:")) {
    try {
      value = decodeURIComponent(value.slice("encoded:".length));
    } catch {
      return "";
    }
  }
  return isNormalWebUrl(value) ? value : "";
}

async function enforceTabUrl(tabId, url, settings = null) {
  if (!Number.isInteger(tabId) || !isNormalWebUrl(url)) return false;
  const currentSettings = settings || (await readSettings());
  if (!urlIsBlocked(url, currentSettings)) return false;

  try {
    await chrome.tabs.update(tabId, { url: blockedPageForUrl(url) });
    return true;
  } catch (error) {
    if (!/No tab with id|Invalid tab ID/i.test(error?.message || "")) throw error;
    return false;
  }
}

async function enforceAllOpenTabs(settings) {
  if (!blockingIsActive(settings)) return;
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs.map((tab) => enforceTabUrl(tab.id, tab.url, settings))
  );
}

async function getRuleDiagnostics(settings) {
  const [rules, hostAccess] = await Promise.all([
    chrome.declarativeNetRequest.getDynamicRules(),
    chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false)
  ]);

  return {
    hostAccess,
    activeRuleCount: rules.length,
    expectedRuleCount: blockingIsActive(settings) ? settings.blocklist.length : 0
  };
}

async function createRedirectRules(blocklist) {
  const rules = [];
  const errors = [];
  const destination = `${BLOCKED_PAGE_URL}#\\0`;

  for (const [index, pattern] of blocklist.entries()) {
    try {
      const regexFilter = patternToRegex(pattern);
      const support = await chrome.declarativeNetRequest.isRegexSupported({
        regex: regexFilter,
        isCaseSensitive: false,
        requireCapturing: true
      });

      if (!support.isSupported) {
        errors.push(`${pattern}: unsupported pattern (${support.reason || "unknown reason"})`);
        continue;
      }

      rules.push({
        id: index + 1,
        priority: 1,
        action: {
          type: "redirect",
          redirect: { regexSubstitution: destination }
        },
        condition: {
          regexFilter,
          isUrlFilterCaseSensitive: false,
          resourceTypes: ["main_frame"]
        }
      });
    } catch (error) {
      errors.push(`${pattern}: ${error.message}`);
    }
  }

  return { rules, errors };
}

async function scheduleModeAlarm(settings, now = Date.now()) {
  await chrome.alarms.clear(MODE_ALARM);
  const candidates = [];

  if (isUltraActive(settings, now)) {
    candidates.push(settings.ultraEndAt);
    if (settings.ultraBreakUntil > now) candidates.push(settings.ultraBreakUntil);
  }

  if (candidates.length) {
    await chrome.alarms.create(MODE_ALARM, { when: Math.min(...candidates) });
  }
}

async function syncRulesUnlocked() {
  const now = Date.now();
  const current = await readSettings();
  const normalized = normalizeExpiredSettings(current, now);
  const settings = normalized.settings;

  if (normalized.changed) await writeSettings(settings);
  await scheduleModeAlarm(settings, now);

  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules.map((rule) => rule.id);

  if (!blockingIsActive(settings, now) || !settings.blocklist.length) {
    if (removeRuleIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    }
    if (settings.lastRuleError) {
      settings.lastRuleError = "";
      await writeSettings(settings);
    }
    await updateBadge(settings, now);
    return settings;
  }

  const { rules, errors } = await createRedirectRules(settings.blocklist);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: rules
  });

  const lastRuleError = errors.join("\n");
  if (settings.lastRuleError !== lastRuleError) {
    settings.lastRuleError = lastRuleError;
    await writeSettings(settings);
  }
  await updateBadge(settings, now);
  return settings;
}

function syncRules() {
  return serialize("state", syncRulesUnlocked);
}

async function updateBadge(settings, now = Date.now()) {
  if (isUltraActive(settings, now)) {
    await chrome.action.setBadgeText({ text: settings.ultraBreakUntil > now ? "5m" : "U" });
    await chrome.action.setTitle({ title: "Blinkers — Ultra mode" });
  } else if (!settings.extensionEnabled) {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Blinkers — disabled" });
  } else if (blockingIsActive(settings, now)) {
    await chrome.action.setBadgeText({ text: "ON" });
    await chrome.action.setTitle({ title: "Blinkers — blocking" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Blinkers — daily time available" });
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#1f2937" });
}

async function getStatus(allowPopupFocus = false) {
  await flushAndRefreshTracker(allowPopupFocus);
  const now = Date.now();
  const normalized = normalizeExpiredSettings(await readSettings(), now);
  const settings = normalized.changed ? await syncRules() : normalized.settings;
  const diagnostics = await getRuleDiagnostics(settings);
  const tracker = (await chrome.storage.session.get(TRACKER_KEY))[TRACKER_KEY];
  const simpleTotalMs = simpleDailyTotalMs(settings, now);
  const simpleRemainingMs = simpleTimeRemainingMs(settings, now);
  return {
    settings,
    now,
    blockingActive: blockingIsActive(settings, now),
    ultraActive: isUltraActive(settings, now),
    ultraBreakAvailable:
      isUltraActive(settings, now) &&
      settings.ultraBreakAllowed &&
      settings.ultraBreakUntil <= now &&
      settings.ultraCooldownUntil <= now,
    ultraBreakInProgress: settings.ultraBreakUntil > now,
    simpleRemainingMs,
    simpleUsedMs: Math.max(0, simpleTotalMs - simpleRemainingMs),
    simpleTracking: Boolean(tracker?.countsTowardSimpleLimit),
    diagnostics
  };
}

function assertListEditable(settings) {
  if (isUltraActive(settings)) {
    throw new Error("The blocklist is locked until Ultra mode finishes.");
  }
}

async function mutateSettings(mutator, syncBlocking = true) {
  return serialize("state", async () => {
    const normalized = normalizeExpiredSettings(await readSettings());
    const settings = normalized.settings;
    await mutator(settings);
    await writeSettings(settings);
    if (syncBlocking) {
      await syncRulesUnlocked();
      await enforceAllOpenTabs(settings);
    }
  });
}

async function addPattern(pattern) {
  return mutateSettings((settings) => {
    assertListEditable(settings);
    const [candidate] = dedupePatterns([pattern]);
    if (!candidate) throw new Error("Enter a site or pattern.");
    patternToRegex(candidate);
    const key = candidate.toLowerCase();
    if (settings.blocklist.some((item) => item.toLowerCase() === key)) return;
    if (settings.blocklist.length >= MAX_BLOCKLIST_ITEMS) throw new Error("Blocklist limit reached.");
    settings.blocklist.push(candidate);
  });
}

async function removePattern(pattern) {
  return mutateSettings((settings) => {
    assertListEditable(settings);
    const key = String(pattern).toLowerCase();
    settings.blocklist = settings.blocklist.filter((item) => item.toLowerCase() !== key);
  });
}

async function replacePatterns(patterns) {
  return mutateSettings((settings) => {
    assertListEditable(settings);
    const next = dedupePatterns(patterns);
    for (const pattern of next) patternToRegex(pattern);
    settings.blocklist = next;
  });
}

async function setExtensionEnabled(enabled) {
  return mutateSettings((settings) => {
    if (isUltraActive(settings)) throw new Error("Ultra mode is locked.");
    settings.mode = "simple";
    settings.extensionEnabled = Boolean(enabled);
  });
}

async function setSimpleDailyLimit(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 0 || value > MAX_SIMPLE_DAILY_MINUTES) {
    throw new Error(`Daily time must be between 0 and ${MAX_SIMPLE_DAILY_MINUTES} minutes.`);
  }
  return mutateSettings((settings) => {
    if (isUltraActive(settings)) throw new Error("Ultra mode is locked.");
    settings.simpleDailyLimitMinutes = Math.round(value);
    settings.simpleAllowanceUsedMs = Math.min(
      simpleDailyTotalMs(settings),
      Math.max(0, Number(settings.simpleAllowanceUsedMs) || 0)
    );
  });
}

async function setHideYouTubeShorts(enabled) {
  return mutateSettings((settings) => {
    if (isUltraActive(settings)) throw new Error("Page filters are locked until Ultra mode finishes.");
    settings.hideYouTubeShorts = Boolean(enabled);
  }, false);
}

async function sourceTabForMessage(sender) {
  if (Number.isInteger(sender?.tab?.id)) return sender.tab;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function requestSimpleChallenge(sender, requestedReturnUrl = "") {
  const now = Date.now();
  const normalized = normalizeExpiredSettings(await readSettings(), now);
  const settings = normalized.settings;
  const sourceTab = await sourceTabForMessage(sender);
  const effectiveReturnUrl = isNormalWebUrl(requestedReturnUrl)
    ? requestedReturnUrl
    : originalUrlFromBlockedPage(sourceTab?.url || "");

  if (isUltraActive(settings, now)) {
    throw new Error("Use the Ultra 5-minute break instead.");
  }
  if (!settings.extensionEnabled) throw new Error("Blinkers is disabled.");
  if (simpleTimeRemainingMs(settings, now) > 0) throw new Error("Daily time is still available.");

  const challenge = {
    token: crypto.randomUUID(),
    minutes: SIMPLE_BONUS_MINUTES,
    createdAt: now,
    startedAt: 0,
    completedAt: 0,
    returnTabId: Number.isInteger(sourceTab?.id) ? sourceTab.id : null,
    returnUrl: effectiveReturnUrl
  };

  await chrome.storage.session.set({ [SIMPLE_CHALLENGE_KEY]: challenge });
  return { token: challenge.token };
}

async function readSimpleChallenge(token) {
  const stored = await chrome.storage.session.get(SIMPLE_CHALLENGE_KEY);
  const challenge = stored[SIMPLE_CHALLENGE_KEY];
  const now = Date.now();
  if (!challenge || challenge.token !== token || now - challenge.createdAt > SIMPLE_CHALLENGE_TTL_MS) {
    throw new Error("This challenge expired. Close it and request another.");
  }
  return challenge;
}

async function getSimpleChallenge(token) {
  const challenge = await readSimpleChallenge(token);
  return {
    minutes: challenge.minutes,
    requiredMs: CHALLENGE_REQUIRED_MS
  };
}

async function beginSimpleChallenge(token) {
  const challenge = await readSimpleChallenge(token);
  if (!challenge.startedAt) {
    challenge.startedAt = Date.now();
    await chrome.storage.session.set({ [SIMPLE_CHALLENGE_KEY]: challenge });
  }
  return true;
}

async function completeSimpleChallenge(token) {
  return serialize("state", async () => {
    const challenge = await readSimpleChallenge(token);
    const now = Date.now();

    if (challenge.completedAt) {
      return { minutes: challenge.minutes };
    }
    if (!challenge.startedAt || now - challenge.startedAt < CHALLENGE_REQUIRED_MS) {
      throw new Error("Complete the challenge for the full duration.");
    }

    const normalized = normalizeExpiredSettings(await readSettings(), now);
    const settings = normalized.settings;
    if (isUltraActive(settings, now)) throw new Error("Ultra mode is active.");
    if (!settings.extensionEnabled) throw new Error("Blinkers is disabled.");

    settings.mode = "simple";
    settings.simpleBonusMinutes = Math.max(0, Number(settings.simpleBonusMinutes) || 0) + SIMPLE_BONUS_MINUTES;
    await writeSettings(settings);
    await syncRulesUnlocked();

    challenge.completedAt = now;
    await chrome.storage.session.set({ [SIMPLE_CHALLENGE_KEY]: challenge });

    return { minutes: challenge.minutes };
  });
}

async function finishSimpleChallenge(token) {
  const stored = await chrome.storage.session.get(SIMPLE_CHALLENGE_KEY);
  const challenge = stored[SIMPLE_CHALLENGE_KEY];
  if (!challenge || challenge.token !== token || !challenge.completedAt) {
    throw new Error("The completed challenge could not be found.");
  }

  if (Number.isInteger(challenge.returnTabId)) {
    try {
      const update = { active: true };
      if (challenge.returnUrl) update.url = challenge.returnUrl;
      await chrome.tabs.update(challenge.returnTabId, update);
    } catch {}
  }

  await chrome.storage.session.remove(SIMPLE_CHALLENGE_KEY);
  return true;
}

async function cancelSimpleChallenge(token) {
  const stored = await chrome.storage.session.get(SIMPLE_CHALLENGE_KEY);
  const challenge = stored[SIMPLE_CHALLENGE_KEY];
  if (challenge?.token === token && !challenge.completedAt) {
    await chrome.storage.session.remove(SIMPLE_CHALLENGE_KEY);
  }
  if (Number.isInteger(challenge?.returnTabId)) {
    await chrome.tabs.update(challenge.returnTabId, { active: true }).catch(() => {});
  }
  return true;
}

async function startUltra(durationMinutes, commitmentText) {
  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration) || duration < MIN_ULTRA_MINUTES || duration > MAX_ULTRA_MINUTES) {
    throw new Error(`Ultra duration must be between ${MIN_ULTRA_MINUTES} minutes and 7 days.`);
  }
  if (commitmentText !== ULTRA_COMMITMENT) {
    throw new Error(`Type ${ULTRA_COMMITMENT} exactly to begin.`);
  }

  return mutateSettings((settings) => {
    if (isUltraActive(settings)) throw new Error("Ultra mode is already active.");
    const now = Date.now();
    settings.mode = "ultra";
    settings.extensionEnabled = true;
    settings.ultraEndAt = now + Math.round(duration * 60000);
    settings.ultraBreakUntil = 0;
    settings.ultraCooldownUntil = 0;
    settings.ultraBreakAllowed = duration >= 60;
  });
}

async function startUltraBreak() {
  return mutateSettings((settings) => {
    const now = Date.now();
    if (!isUltraActive(settings, now)) throw new Error("Ultra mode is not active.");
    if (!settings.ultraBreakAllowed) throw new Error("Breaks require an Ultra session of at least one hour.");
    if (settings.ultraBreakUntil > now) throw new Error("The 5-minute break is already running.");
    if (settings.ultraCooldownUntil > now) throw new Error("The next Ultra break is not available yet.");

    settings.ultraBreakUntil = now + 5 * 60000;
    settings.ultraCooldownUntil = settings.ultraBreakUntil + 60 * 60000;
  });
}

async function readUsage() {
  const stored = await chrome.storage.local.get(USAGE_KEY);
  return stored[USAGE_KEY] && typeof stored[USAGE_KEY] === "object" ? stored[USAGE_KEY] : {};
}

async function writeUsage(usage) {
  const validKeys = new Set(recentDateKeys(30));
  for (const key of Object.keys(usage)) {
    if (!validKeys.has(key)) delete usage[key];
  }
  await chrome.storage.local.set({ [USAGE_KEY]: usage });
}

function isTransientWindowError(error) {
  return /No (?:last-focused|current) window|No window with id|Invalid window ID/i.test(error?.message || "");
}

async function getFocusedTab(allowPopupFocus) {
  try {
    const window = await chrome.windows.getLastFocused({ populate: false });
    if (
      !window ||
      window.id === chrome.windows.WINDOW_ID_NONE ||
      (!window.focused && !popupPorts.size && !allowPopupFocus)
    ) return null;
    const tabs = await chrome.tabs.query({ active: true, windowId: window.id });
    return tabs[0] ? { tab: tabs[0], windowId: window.id } : null;
  } catch (error) {
    if (isTransientWindowError(error)) return null;
    throw error;
  }
}

async function getActiveContext(allowPopupFocus = false) {
  const idleState = await chrome.idle.queryState(60);
  if (idleState !== "active") return null;

  const focused = await getFocusedTab(allowPopupFocus);
  if (!focused || !Number.isInteger(focused.tab.id) || !focused.tab.url) return null;

  const domain = hostnameFromUrl(focused.tab.url);
  if (!domain) return null;
  const settings = normalizeExpiredSettings(await readSettings()).settings;
  const countsTowardSimpleLimit =
    settings.mode === "simple" &&
    settings.extensionEnabled &&
    simpleTimeRemainingMs(settings) > 0 &&
    settings.blocklist.some((pattern) => urlMatchesPattern(focused.tab.url, pattern));
  return {
    domain,
    tabId: focused.tab.id,
    windowId: focused.windowId,
    startedAt: Date.now(),
    countsTowardSimpleLimit
  };
}

async function scheduleQuotaAlarm(tracker) {
  await chrome.alarms.clear(QUOTA_ALARM);
  if (!tracker?.countsTowardSimpleLimit) return;
  const settings = normalizeExpiredSettings(await readSettings()).settings;
  const remainingMs = simpleTimeRemainingMs(settings);
  if (remainingMs > 0) await chrome.alarms.create(QUOTA_ALARM, { when: Date.now() + remainingMs });
}

async function flushAndRefreshTrackerUnlocked(allowPopupFocus = false) {
  const now = Date.now();
  const stored = await chrome.storage.session.get(TRACKER_KEY);
  const tracker = stored[TRACKER_KEY];

  if (tracker?.domain && tracker.startedAt) {
    const elapsed = Math.min(Math.max(0, now - tracker.startedAt), MAX_TRACK_SLICE_MS);
    if (elapsed > 0) {
      const usage = await readUsage();
      const key = dateKey(now);
      usage[key] ||= {};
      usage[key][tracker.domain] = (Number(usage[key][tracker.domain]) || 0) + elapsed;
      await writeUsage(usage);

      if (tracker.countsTowardSimpleLimit) {
        await serialize("state", async () => {
          const settings = normalizeExpiredSettings(await readSettings(), now).settings;
          if (settings.mode !== "simple" || !settings.extensionEnabled) return;
          const totalMs = simpleDailyTotalMs(settings, now);
          settings.simpleAllowanceUsedMs = Math.min(
            totalMs,
            Math.max(0, Number(settings.simpleAllowanceUsedMs) || 0) + elapsed
          );
          await writeSettings(settings);
          if (simpleTimeRemainingMs(settings, now) <= 0) {
            await syncRulesUnlocked();
            await enforceAllOpenTabs(settings);
          }
        });
      }
    }
  }

  const nextTracker = await getActiveContext(allowPopupFocus);
  if (nextTracker) await chrome.storage.session.set({ [TRACKER_KEY]: nextTracker });
  else await chrome.storage.session.remove(TRACKER_KEY);
  await scheduleQuotaAlarm(nextTracker);
}

function flushAndRefreshTracker(allowPopupFocus = false) {
  return serialize("tracker", () => flushAndRefreshTrackerUnlocked(allowPopupFocus));
}

async function getUsageSummary(days = 1, refreshTracker = true) {
  if (refreshTracker) await flushAndRefreshTracker();
  const safeDays = [1, 7, 30].includes(Number(days)) ? Number(days) : 1;
  const usage = await readUsage();
  const totals = {};

  for (const key of recentDateKeys(safeDays)) {
    for (const [domain, ms] of Object.entries(usage[key] || {})) {
      totals[domain] = (totals[domain] || 0) + Number(ms || 0);
    }
  }

  const top = Object.entries(totals)
    .map(([domain, ms]) => ({ domain, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5);

  return { days: safeDays, top, totalMs: Object.values(totals).reduce((sum, ms) => sum + ms, 0) };
}

async function resetUsage() {
  await serialize("tracker", async () => {
    await chrome.storage.local.remove(USAGE_KEY);
    await chrome.storage.session.remove(TRACKER_KEY);
    const tracker = await getActiveContext();
    if (tracker) await chrome.storage.session.set({ [TRACKER_KEY]: tracker });
    await scheduleQuotaAlarm(tracker);
  });
}

async function getCurrentSitePattern() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.url) return "";

  const candidate = originalUrlFromBlockedPage(tab.url) || tab.url;
  return hostnameFromUrl(candidate);
}

async function initialize() {
  await chrome.alarms.create(TRACK_ALARM, { periodInMinutes: 1 });
  const settings = await syncRules();
  await enforceAllOpenTabs(settings);
  await flushAndRefreshTracker();
}

chrome.runtime.onInstalled.addListener(() => {
  run((async () => {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    if (!stored[SETTINGS_KEY]) await writeSettings(DEFAULT_SETTINGS);
    await initialize();
  })());
});

chrome.runtime.onStartup.addListener(() => run(initialize()));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MODE_ALARM) {
    run(syncRules().then((settings) => enforceAllOpenTabs(settings)));
  }
  if (alarm.name === TRACK_ALARM) run(flushAndRefreshTracker());
  if (alarm.name === QUOTA_ALARM) run(flushAndRefreshTracker());
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  run(flushAndRefreshTracker());
  try {
    const tab = await chrome.tabs.get(tabId);
    run(enforceTabUrl(tabId, tab.url));
  } catch {}
});
chrome.tabs.onRemoved.addListener(() => run(flushAndRefreshTracker()));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) run(enforceTabUrl(tabId, changeInfo.url));
  else if (changeInfo.status === "complete" && tab.url) run(enforceTabUrl(tabId, tab.url));
  if (tab.active && (changeInfo.url || changeInfo.status === "complete")) run(flushAndRefreshTracker());
});
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) run(enforceTabUrl(details.tabId, details.url));
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) run(enforceTabUrl(details.tabId, details.url));
});
chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  if (details.frameId === 0) run(enforceTabUrl(details.tabId, details.url));
});
chrome.windows.onFocusChanged.addListener(() => run(flushAndRefreshTracker()));
chrome.idle.onStateChanged.addListener(() => run(flushAndRefreshTracker()));

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== POPUP_PORT_NAME || port.sender?.id !== chrome.runtime.id) return;
  popupPorts.add(port);
  run(flushAndRefreshTracker());
  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
    run(flushAndRefreshTracker());
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      if (sender.id !== chrome.runtime.id) throw new Error("Unauthorized extension request.");
      let data;
      const fromPopup = sender?.url === chrome.runtime.getURL("popup.html");
      switch (message?.type) {
        case "getStatus":
          data = await getStatus(fromPopup);
          break;
        case "getDashboard":
          data = { status: await getStatus(fromPopup), usage: await getUsageSummary(message.days || 1, false) };
          break;
        case "addPattern":
          await addPattern(message.pattern);
          data = await getStatus(fromPopup);
          break;
        case "removePattern":
          await removePattern(message.pattern);
          data = await getStatus(fromPopup);
          break;
        case "replacePatterns":
          await replacePatterns(message.patterns || []);
          data = await getStatus(fromPopup);
          break;
        case "setExtensionEnabled":
          await setExtensionEnabled(message.enabled);
          data = await getStatus(fromPopup);
          break;
        case "setSimpleDailyLimit":
          await setSimpleDailyLimit(message.minutes);
          data = await getStatus(fromPopup);
          break;
        case "setHideYouTubeShorts":
          await setHideYouTubeShorts(message.enabled);
          data = await getStatus(fromPopup);
          break;
        case "requestSimpleChallenge":
          data = await requestSimpleChallenge(sender, message.returnUrl || "");
          break;
        case "getSimpleChallenge":
          data = await getSimpleChallenge(message.token);
          break;
        case "beginSimpleChallenge":
          data = await beginSimpleChallenge(message.token);
          break;
        case "completeSimpleChallenge":
          data = await completeSimpleChallenge(message.token);
          break;
        case "finishSimpleChallenge":
          data = await finishSimpleChallenge(message.token);
          break;
        case "cancelSimpleChallenge":
          data = await cancelSimpleChallenge(message.token);
          break;
        case "startUltra":
          await startUltra(message.durationMinutes, message.commitmentText);
          data = await getStatus(fromPopup);
          break;
        case "startUltraBreak":
          await startUltraBreak();
          data = await getStatus(fromPopup);
          break;
        case "getUsage":
          data = await getUsageSummary(message.days);
          break;
        case "resetUsage":
          await resetUsage();
          data = true;
          break;
        case "getCurrentSite":
          data = await getCurrentSitePattern();
          break;
        default:
          throw new Error("Unknown extension command.");
      }
      sendResponse({ ok: true, data });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();
  return true;
});

run(syncRules().then((settings) => enforceAllOpenTabs(settings)));
run(chrome.alarms.create(TRACK_ALARM, { periodInMinutes: 1 }));
