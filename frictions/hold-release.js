const MIN_PHASE_MS = 1500;
const MAX_PHASE_MS = 2500;
const INPUT_GRACE_MS = 1000;
const EARLY_TRANSITION_GRACE_MS = 90;
const RESTART_DELAY_MS = 1050;
const MIN_SCALE = 0.58;
const MAX_SCALE = 1;

function randomPhaseDuration() {
  const sample = new Uint32Array(1);
  crypto.getRandomValues(sample);
  const ratio = sample[0] / 0x1_0000_0000;
  return Math.round(MIN_PHASE_MS + ratio * (MAX_PHASE_MS - MIN_PHASE_MS));
}

function easeInOut(value) {
  return 0.5 - Math.cos(Math.PI * value) / 2;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function mountChallenge({ root, challenge, onBegin, onComplete }) {
  root.innerHTML = `
    <div class="hold-release-game" tabindex="-1">
      <div class="hold-release-stage" aria-hidden="true">
        <div class="hold-release-orbit">
          <div class="hold-release-circle"></div>
        </div>
      </div>
      <div class="hold-release-cue" aria-live="polite">
        <div class="hold-release-command">Ready?</div>
      </div>
      <div class="hold-release-meta">
        <div class="hold-release-progress-track"><div class="hold-release-progress-bar"></div></div>
        <div class="hold-release-time"></div>
      </div>
      <button class="hold-release-start" type="button">Begin challenge · Enter</button>
    </div>`;

  const game = root.querySelector(".hold-release-game");
  const stage = root.querySelector(".hold-release-stage");
  const circle = root.querySelector(".hold-release-circle");
  const command = root.querySelector(".hold-release-command");
  const progressBar = root.querySelector(".hold-release-progress-bar");
  const time = root.querySelector(".hold-release-time");
  const startButton = root.querySelector(".hold-release-start");

  const requiredMs = Number(challenge.requiredMs) || 30_000;
  let running = false;
  let completing = false;
  let holding = false;
  let phase = "expand";
  let phaseStart = 0;
  let phaseDuration = 0;
  let graceUntil = 0;
  let runStart = 0;
  let animationFrame = 0;
  let restartTimer = 0;
  let beganServerChallenge = false;
  let disposed = false;

  function setHolding(next) {
    holding = next;
    game.classList.toggle("is-holding", holding);
  }

  function setCue() {
    const expanding = phase === "expand";
    command.textContent = expanding ? "HOLD" : "RELEASE";
    command.className = `hold-release-command ${expanding ? "expand" : "contract"}`;
  }

  function setVisual(now) {
    const phaseProgress = clamp((now - phaseStart) / phaseDuration, 0, 1);
    const eased = easeInOut(phaseProgress);
    const scale = phase === "expand"
      ? MIN_SCALE + (MAX_SCALE - MIN_SCALE) * eased
      : MAX_SCALE - (MAX_SCALE - MIN_SCALE) * eased;
    circle.style.transform = `scale(${scale.toFixed(4)})`;

    const elapsed = clamp(now - runStart, 0, requiredMs);
    const progress = elapsed / requiredMs;
    stage.style.setProperty("--progress", `${progress * 360}deg`);
    progressBar.style.width = `${progress * 100}%`;
    time.textContent = `${Math.max(0, (requiredMs - elapsed) / 1000).toFixed(1)}s`;
  }

  function clearRun() {
    running = false;
    cancelAnimationFrame(animationFrame);
    window.clearTimeout(restartTimer);
  }

  function failRun() {
    if (!running || completing) return;
    clearRun();
    setHolding(false);
    game.classList.add("is-failed");
    command.textContent = "MISSED";
    command.className = "hold-release-command";
    progressBar.style.width = "0%";
    stage.style.setProperty("--progress", "0deg");
    time.textContent = `${(requiredMs / 1000).toFixed(1)}s`;
    circle.style.transform = `scale(${MIN_SCALE})`;
    restartTimer = window.setTimeout(() => {
      game.classList.remove("is-failed");
      startRun();
    }, RESTART_DELAY_MS);
  }

  async function succeed() {
    if (completing) return;
    completing = true;
    clearRun();
    command.textContent = "COMPLETE";
    command.className = "hold-release-command expand";
    progressBar.style.width = "100%";
    stage.style.setProperty("--progress", "360deg");
    time.textContent = "0.0s";
    try {
      await onComplete();
    } catch (error) {
      completing = false;
      command.textContent = error?.message || "Could not unlock";
      command.className = "hold-release-command";
      startButton.hidden = false;
      startButton.disabled = false;
      startButton.textContent = "Try again · Enter";
    }
  }

  function frame(now) {
    if (!running) return;

    while (now - phaseStart >= phaseDuration) {
      phaseStart += phaseDuration;
      phase = phase === "expand" ? "contract" : "expand";
      phaseDuration = randomPhaseDuration();
      graceUntil = now + INPUT_GRACE_MS;
      setCue();
    }

    setVisual(now);
    const expectedHolding = phase === "expand";
    const timeToTransition = phaseStart + phaseDuration - now;
    const inResponseWindow = now <= graceUntil || timeToTransition <= EARLY_TRANSITION_GRACE_MS;
    if (!inResponseWindow && holding !== expectedHolding) {
      failRun();
      return;
    }

    if (now - runStart >= requiredMs) {
      void succeed();
      return;
    }
    animationFrame = requestAnimationFrame(frame);
  }

  function startRun() {
    if (completing || disposed) return;
    window.clearTimeout(restartTimer);
    running = true;
    setHolding(false);
    phase = "expand";
    runStart = performance.now();
    phaseStart = runStart;
    phaseDuration = randomPhaseDuration();
    graceUntil = runStart + INPUT_GRACE_MS;
    setCue();
    startButton.hidden = true;
    stage.style.setProperty("--progress", "0deg");
    progressBar.style.width = "0%";
    time.textContent = `${(requiredMs / 1000).toFixed(1)}s`;
    animationFrame = requestAnimationFrame(frame);
    game.focus({ preventScroll: true });
  }

  async function begin() {
    if (running || completing) return;
    startButton.disabled = true;
    startButton.textContent = "Starting…";
    try {
      if (!beganServerChallenge) {
        await onBegin();
        beganServerChallenge = true;
      }
      startRun();
    } catch (error) {
      startButton.disabled = false;
      startButton.textContent = "Begin challenge · Enter";
      command.textContent = error?.message || "Could not start";
    }
  }

  function onKeyDown(event) {
    if (disposed) return;
    if (event.key === "Enter" && !running && !completing && !startButton.disabled && !startButton.hidden) {
      event.preventDefault();
      void begin();
      return;
    }
    if (event.code !== "Space") return;
    event.preventDefault();
    if (!running) return;
    if (!event.repeat) setHolding(true);
  }

  function onKeyUp(event) {
    if (disposed || event.code !== "Space") return;
    event.preventDefault();
    if (!running) return;
    setHolding(false);
  }

  function interrupt() {
    if (!running) return;
    failRun();
  }

  function onVisibilityChange() {
    if (document.hidden) interrupt();
  }

  startButton.addEventListener("click", () => void begin());
  window.addEventListener("keydown", onKeyDown, { passive: false });
  window.addEventListener("keyup", onKeyUp, { passive: false });
  window.addEventListener("blur", interrupt);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    if (disposed) return;
    disposed = true;
    clearRun();
    setHolding(false);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", interrupt);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
