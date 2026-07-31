export const DEFAULT_SETTINGS = Object.freeze({
  blocklist: ["reddit.com", "x.com"],
  mode: "simple",
  extensionEnabled: true,
  simpleDailyLimitMinutes: 30,
  simpleAllowanceDay: "",
  simpleAllowanceUsedMs: 0,
  simpleBonusMinutes: 0,
  hideYouTubeShorts: false,
  ultraEndAt: 0,
  ultraBreakUntil: 0,
  ultraCooldownUntil: 0,
  ultraBreakAllowed: false,
  lastRuleError: ""
});

export const ULTRA_COMMITMENT = "LOCK IT IN";
export const MAX_BLOCKLIST_ITEMS = 900;
export const MIN_ULTRA_MINUTES = 15;
export const MAX_ULTRA_MINUTES = 7 * 24 * 60;
export const MAX_SIMPLE_DAILY_MINUTES = 120;

export function mergeSettings(value = {}) {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...value,
    extensionEnabled: typeof value.extensionEnabled === "boolean"
      ? value.extensionEnabled
      : typeof value.simpleEnabled === "boolean"
        ? value.simpleEnabled
        : DEFAULT_SETTINGS.extensionEnabled,
    simpleDailyLimitMinutes: Math.round(Math.min(
      MAX_SIMPLE_DAILY_MINUTES,
      Math.max(0, Number(value.simpleDailyLimitMinutes ?? DEFAULT_SETTINGS.simpleDailyLimitMinutes) || 0)
    )),
    simpleAllowanceUsedMs: Math.max(0, Number(value.simpleAllowanceUsedMs) || 0),
    simpleBonusMinutes: Math.max(0, Number(value.simpleBonusMinutes) || 0),
    hideYouTubeShorts: Boolean(value.hideYouTubeShorts),
    ultraBreakAllowed: Boolean(value.ultraBreakAllowed),
    blocklist: Array.isArray(value.blocklist)
      ? value.blocklist.filter((item) => typeof item === "string")
      : [...DEFAULT_SETTINGS.blocklist]
  };
  delete settings.simpleEnabled;
  delete settings.snoozeUntil;
  delete settings.simpleSnoozeDay;
  delete settings.simpleSnoozeCount;
  delete settings.simpleChallengeType;
  delete settings.snoozeFrictionType;
  return settings;
}

export function isUltraActive(settings, now = Date.now()) {
  return settings.mode === "ultra" && Number(settings.ultraEndAt) > now;
}

export function simpleDailyTotalMs(settings, now = Date.now()) {
  const dayMatches = settings.simpleAllowanceDay === dateKey(now);
  const baseMinutes = Math.min(MAX_SIMPLE_DAILY_MINUTES, Math.max(0, Number(settings.simpleDailyLimitMinutes) || 0));
  const bonusMinutes = dayMatches ? Math.max(0, Number(settings.simpleBonusMinutes) || 0) : 0;
  return (baseMinutes + bonusMinutes) * 60000;
}

export function simpleTimeRemainingMs(settings, now = Date.now()) {
  const usedMs = settings.simpleAllowanceDay === dateKey(now)
    ? Math.max(0, Number(settings.simpleAllowanceUsedMs) || 0)
    : 0;
  return Math.max(0, simpleDailyTotalMs(settings, now) - usedMs);
}

export function blockingIsActive(settings, now = Date.now()) {
  if (isUltraActive(settings, now)) {
    return Number(settings.ultraBreakUntil) <= now;
  }
  return settings.mode === "simple" && Boolean(settings.extensionEnabled) && simpleTimeRemainingMs(settings, now) <= 0;
}

function cleanPattern(input) {
  let pattern = String(input ?? "").trim();
  if (!pattern) return "";

  pattern = pattern.replace(/^view-source:/i, "");
  pattern = pattern.replace(/\s+/g, "");

  const hashIndex = pattern.indexOf("#");
  if (hashIndex >= 0) pattern = pattern.slice(0, hashIndex);

  return pattern.slice(0, 500);
}

export function dedupePatterns(patterns) {
  const seen = new Set();
  const result = [];
  for (const raw of patterns) {
    const value = cleanPattern(raw);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= MAX_BLOCKLIST_ITEMS) break;
  }
  return result;
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(value, starExpression = ".*") {
  return escapeRegex(value).replace(/\*/g, starExpression);
}

function hostPatternToRegex(hostPattern, broadNakedDomain) {
  let host = hostPattern.toLowerCase();
  const portIndex = host.lastIndexOf(":");
  let explicitPort = "";

  if (portIndex > 0 && /^\d+$/.test(host.slice(portIndex + 1))) {
    explicitPort = `:${host.slice(portIndex + 1)}`;
    host = host.slice(0, portIndex);
  }

  let hostRegex;
  if (host.startsWith("*.")) {
    hostRegex = `(?:[^./]+\\.)*${globToRegex(host.slice(2), "[^/]*")}`;
  } else if (host.includes("*")) {
    hostRegex = globToRegex(host, "[^/]*");
  } else if (broadNakedDomain) {
    hostRegex = `(?:[^./]+\\.)*${escapeRegex(host)}`;
  } else {
    hostRegex = escapeRegex(host);
  }

  return `${hostRegex}${explicitPort ? escapeRegex(explicitPort) : "(?::\\d+)?"}`;
}

export function patternToRegex(rawPattern) {
  const pattern = cleanPattern(rawPattern);
  if (!pattern) throw new Error("Empty pattern");

  let schemeRegex = "https?";
  let rest = pattern;
  let hasExplicitScheme = false;

  const schemeMatch = rest.match(/^([a-z*][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    hasExplicitScheme = true;
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === "*") schemeRegex = "https?";
    else if (scheme === "http" || scheme === "https") schemeRegex = scheme;
    else throw new Error("Only http://, https://, or *:// patterns are supported");
    rest = rest.slice(schemeMatch[0].length);
  }

  const slashIndex = rest.indexOf("/");
  const hostPart = slashIndex >= 0 ? rest.slice(0, slashIndex) : rest;
  const suffix = slashIndex >= 0 ? rest.slice(slashIndex) : "";

  if (!hostPart || hostPart.includes("@")) {
    throw new Error("Enter a domain or URL without login credentials");
  }

  const broadNakedDomain = !hasExplicitScheme && !hostPart.includes("*");
  const hostRegex = hostPatternToRegex(hostPart, broadNakedDomain);

  let suffixRegex;
  if (!suffix) {
    suffixRegex = "(?:[/?#].*)?";
  } else {
    suffixRegex = globToRegex(suffix, ".*");
    if (!suffix.includes("?") && !suffix.includes("#")) {
      suffixRegex += "(?:[?#].*)?";
    }
  }

  return `^${schemeRegex}://${hostRegex}${suffixRegex}$`;
}

export function formatDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const totalMinutes = Math.floor(safeMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const seconds = Math.floor((safeMs % 60000) / 1000);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (totalMinutes > 0) return `${totalMinutes}m`;
  return `${seconds}s`;
}

export function formatUsage(ms) {
  const totalMinutes = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function dateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function recentDateKeys(days, now = Date.now()) {
  const result = [];
  const date = new Date(now);
  date.setHours(12, 0, 0, 0);
  for (let i = 0; i < days; i += 1) {
    result.push(dateKey(date.getTime()));
    date.setDate(date.getDate() - 1);
  }
  return result;
}

export function hostnameFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function humanDateTime(timestamp) {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}
