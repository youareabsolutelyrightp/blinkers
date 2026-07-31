const CLASS_NAME = "blinkers-hide-youtube-shorts";
const FILTER_CLASS_NAME = "blinkers-youtube-shorts-filter";
const FILTER_SELECTOR = "yt-chip-cloud-chip-renderer, yt-chip-view-model, chip-shape";
const SHORTS_PATH = /^\/shorts(?:\/|$)/;
let enabled = false;
let filterObserver;

function isShortsUrl(value) {
  try {
    return SHORTS_PATH.test(new URL(value, location.href).pathname);
  } catch {
    return false;
  }
}

function leaveShorts() {
  if (enabled && isShortsUrl(location.href)) location.replace(`${location.origin}/`);
}

function updateFilter(element) {
  const label = element.textContent.replace(/\s+/g, " ").trim();
  element.classList.toggle(FILTER_CLASS_NAME, label === "Shorts");
}

function scanFilters(root = document) {
  const element = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
  const ancestor = element?.closest(FILTER_SELECTOR);
  if (ancestor) updateFilter(ancestor);
  if (element?.matches(FILTER_SELECTOR)) updateFilter(element);
  for (const filter of root.querySelectorAll?.(FILTER_SELECTOR) || []) updateFilter(filter);
}

function observeFilters() {
  scanFilters();
  if (filterObserver || !document.documentElement) return;
  filterObserver = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target.nodeType === Node.ELEMENT_NODE
        ? record.target
        : record.target.parentElement;
      const filter = target?.closest(FILTER_SELECTOR);
      if (filter) updateFilter(filter);
      for (const node of record.addedNodes) scanFilters(node);
    }
  });
  filterObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function stopObservingFilters() {
  filterObserver?.disconnect();
  filterObserver = undefined;
}

function apply(settings) {
  const extensionEnabled = settings?.extensionEnabled ?? settings?.simpleEnabled ?? true;
  enabled = extensionEnabled && Boolean(settings?.hideYouTubeShorts);
  document.documentElement.classList.toggle(CLASS_NAME, enabled);
  if (enabled) observeFilters();
  else stopObservingFilters();
  leaveShorts();
}

async function sync() {
  const stored = await chrome.storage.local.get("settings");
  apply(stored.settings);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.settings) apply(changes.settings.newValue);
});

function blockShortsClick(event) {
  if (!enabled) return;
  const link = event.composedPath().find((node) => node?.tagName === "A" && isShortsUrl(node.href));
  if (!link) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  location.assign(`${location.origin}/`);
}

document.addEventListener("click", blockShortsClick, true);
document.addEventListener("auxclick", blockShortsClick, true);
document.addEventListener("yt-navigate-finish", leaveShorts);
window.addEventListener("popstate", leaveShorts);

sync().catch(() => document.documentElement.classList.remove(CLASS_NAME));
