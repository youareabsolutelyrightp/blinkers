import { mountChallenge } from "./frictions/hold-release.js";

const activeHosts = new WeakMap();

function challengeMarkup() {
  const panel = document.createElement("section");
  panel.className = "inline-friction-card";
  panel.innerHTML = `
    <header class="inline-friction-header">
      <div>
        <div class="inline-friction-eyebrow">BLINKERS · EXTRA TIME</div>
        <h2>Are you sure you need more time?</h2>
        <p class="inline-friction-prompt">Hold <kbd>Space</kbd> as the circle expands and release as it contracts for 30 seconds—use that time to decide whether you really need the blocked site.</p>
      </div>
      <div class="inline-friction-duration">Loading…</div>
    </header>

    <div class="inline-friction-loading inline-friction-state">
      <div class="inline-friction-loader" aria-hidden="true"></div>
      <p>Preparing challenge…</p>
    </div>

    <div class="inline-friction-challenge hidden">
      <div class="inline-friction-mechanism"></div>
    </div>

    <div class="inline-friction-success inline-friction-state hidden" aria-live="polite">
      <div class="inline-friction-success-mark" aria-hidden="true">✓</div>
      <h2>Extra time unlocked.</h2>
      <p class="inline-friction-success-message"></p>
      <button class="inline-friction-primary inline-friction-finish" type="button">Continue</button>
    </div>

    <div class="inline-friction-error inline-friction-state hidden" role="alert">
      <div class="inline-friction-error-mark" aria-hidden="true">!</div>
      <h2>Challenge unavailable</h2>
      <p class="inline-friction-error-message"></p>
      <button class="inline-friction-secondary inline-friction-close-error" type="button">Close challenge</button>
    </div>

    <footer class="inline-friction-footer">
      <button class="inline-friction-cancel" type="button">Cancel and keep blocking</button>
    </footer>`;
  return panel;
}

export async function openInlineChallenge({
  host,
  token,
  send,
  onCompleted = async () => {},
  onCancelled = async () => {}
}) {
  if (!(host instanceof HTMLElement)) throw new Error("Missing inline challenge host.");
  if (!token) throw new Error("Missing challenge token.");
  if (typeof send !== "function") throw new Error("Missing challenge message handler.");

  activeHosts.get(host)?.dispose();

  const panel = challengeMarkup();
  host.replaceChildren(panel);
  host.classList.remove("hidden");

  const els = {
    duration: panel.querySelector(".inline-friction-duration"),
    loading: panel.querySelector(".inline-friction-loading"),
    challenge: panel.querySelector(".inline-friction-challenge"),
    mechanism: panel.querySelector(".inline-friction-mechanism"),
    success: panel.querySelector(".inline-friction-success"),
    successMessage: panel.querySelector(".inline-friction-success-message"),
    finish: panel.querySelector(".inline-friction-finish"),
    error: panel.querySelector(".inline-friction-error"),
    errorMessage: panel.querySelector(".inline-friction-error-message"),
    closeError: panel.querySelector(".inline-friction-close-error"),
    footer: panel.querySelector(".inline-friction-footer"),
    cancel: panel.querySelector(".inline-friction-cancel")
  };

  let completed = false;
  let completing = false;
  let finishing = false;
  let disposed = false;
  let mechanismCleanup = () => {};
  let finishTimer = 0;

  function dispose() {
    if (disposed) return;
    disposed = true;
    window.clearTimeout(finishTimer);
    mechanismCleanup();
    host.classList.add("hidden");
    host.replaceChildren();
    if (activeHosts.get(host)?.dispose === dispose) activeHosts.delete(host);
  }

  function showError(error) {
    if (disposed) return;
    mechanismCleanup();
    els.loading.classList.add("hidden");
    els.challenge.classList.add("hidden");
    els.success.classList.add("hidden");
    els.error.classList.remove("hidden");
    els.errorMessage.textContent = error?.message || String(error);
  }

  async function finish() {
    if (finishing || disposed) return;
    finishing = true;
    els.finish.disabled = true;
    try {
      await send("finishSimpleChallenge", { token });
    } catch (error) {
      finishing = false;
      els.finish.disabled = false;
      showError(error);
      return;
    }
    try {
      await onCompleted();
    } catch (error) {
      console.error(error);
    }
    dispose();
  }

  async function cancel() {
    if (disposed) return;
    if (completed) return finish();
    els.cancel.disabled = true;
    els.closeError.disabled = true;
    try {
      await send("cancelSimpleChallenge", { token });
    } catch {}
    try {
      await onCancelled();
    } catch (error) {
      console.error(error);
    }
    dispose();
  }

  els.finish.addEventListener("click", () => void finish());
  els.cancel.addEventListener("click", () => void cancel());
  els.closeError.addEventListener("click", () => void cancel());

  const controller = { dispose };
  activeHosts.set(host, controller);

  try {
    const challenge = await send("getSimpleChallenge", { token });
    if (disposed) return controller;

    els.duration.textContent = `${challenge.minutes} minutes`;

    els.loading.classList.add("hidden");
    els.challenge.classList.remove("hidden");

    const cleanup = mountChallenge({
      root: els.mechanism,
      challenge,
      onBegin: () => send("beginSimpleChallenge", { token }),
      onComplete: async () => {
        if (completing || completed) return;
        completing = true;
        els.cancel.disabled = true;
        try {
          const result = await send("completeSimpleChallenge", { token });
          completed = true;
          mechanismCleanup();
          els.challenge.classList.add("hidden");
          els.footer.classList.add("hidden");
          els.success.classList.remove("hidden");
          els.successMessage.textContent = `${result.minutes} minutes added for today.`;
          finishTimer = window.setTimeout(() => void finish(), 900);
        } catch (error) {
          completing = false;
          els.cancel.disabled = false;
          throw error;
        }
      }
    });
    if (typeof cleanup === "function") {
      mechanismCleanup = cleanup;
      if (disposed) mechanismCleanup();
    }
  } catch (error) {
    showError(error);
  }

  return controller;
}
