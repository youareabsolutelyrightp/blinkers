import { formatDuration, humanDateTime } from "./utils.js";
import { openInlineChallenge } from "./inline-friction.js";

const blockedUrl = document.querySelector("#blockedUrl");
const statusBox = document.querySelector("#status");
const temporaryAccess = document.querySelector("#temporaryAccess");
const simpleChallenge = document.querySelector("#simpleChallenge");
const rawHash = location.hash.slice(1);

function originalUrlFromHash() {
  let value = rawHash;
  if (value.startsWith("encoded:")) {
    try {
      value = decodeURIComponent(value.slice("encoded:".length));
    } catch {
      return "";
    }
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

const originalUrl = originalUrlFromHash();
blockedUrl.textContent = originalUrl || "A URL on your blocklist";

document.querySelector("#goBack").addEventListener("click", () => {
  if (history.length > 1) history.back();
  else location.href = "about:blank";
});

document.querySelector("#openSettings").addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Extension request failed.");
  return response.data;
}

async function refresh() {
  try {
    const state = await send("getStatus");
    const { settings, now, ultraActive, ultraBreakAvailable } = state;

    temporaryAccess.classList.add("hidden");
    if (ultraActive) {
      statusBox.textContent = `Ultra mode is locked for ${formatDuration(settings.ultraEndAt - now)} more, until ${humanDateTime(settings.ultraEndAt)}.`;
      if (ultraBreakAvailable) {
        temporaryAccess.textContent = "Use Ultra 5-minute break";
        temporaryAccess.classList.remove("hidden");
        temporaryAccess.onclick = async () => {
          try {
            await send("startUltraBreak");
            if (originalUrl) location.href = originalUrl;
            else history.back();
          } catch (error) {
            statusBox.textContent = error.message;
          }
        };
      } else if (settings.ultraCooldownUntil > now) {
        statusBox.textContent += ` Next break: ${humanDateTime(settings.ultraCooldownUntil)}.`;
      }
      return;
    }

    if (!settings.extensionEnabled || state.simpleRemainingMs > 0) {
      if (originalUrl) location.href = originalUrl;
      else history.back();
      return;
    }

    statusBox.textContent = "Today’s time limit has been reached.";
    temporaryAccess.textContent = "Complete challenge for 15 min";
    temporaryAccess.classList.remove("hidden");
    temporaryAccess.onclick = async () => {
      try {
        const result = await send("requestSimpleChallenge", { returnUrl: originalUrl });
        await openInlineChallenge({
          host: simpleChallenge,
          token: result.token,
          send,
          onCompleted: async () => {
            if (originalUrl) location.href = originalUrl;
            else history.back();
          },
          onCancelled: refresh
        });
      } catch (error) {
        statusBox.textContent = error.message;
      }
    };
  } catch (error) {
    statusBox.textContent = error.message;
  }
}

void refresh();
