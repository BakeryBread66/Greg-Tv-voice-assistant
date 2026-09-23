// How long Greg lives when Greg.exe started him: as long as his window does.
//
// Started from start-greg.bat he has a console, and closing the console is how
// you stop him. Started from Greg.exe he has no console at all, and a server
// that outlives its window is a server nobody can see holding 8-14 GB of the
// graphics card. So in that mode the page keeps a presence stream open
// (/api/presence), and when the last one has been gone for a grace period, he
// shuts down cleanly, the same way Ctrl+C does.
//
// The grace period is what makes a reload survivable. Reloading drops the
// stream and opens a new one a second or two later; so does the EventSource's
// own reconnect after a blip. Fifteen seconds covers both with room to spare,
// and is short enough that "I closed him" and "he let go of the card" feel like
// the same event.
//
// Nothing is decided until a page has connected at least once. The window opens
// at the END of a startup that can take minutes on a first run, while the
// speech models download, and "no window yet" must not read as "window closed".
//
// Pure, with the timer injected, so the decision is proven without waiting.

export const GRACE_MS = 15000;

/** Was this server started by Greg.exe, which gives him no console to close? */
export function startedByLauncher(env = process.env) {
  return env?.GREG_LAUNCHER === "1";
}

/**
 * Count open windows and call `onAllClosed` once none has been back for
 * `graceMs`.
 *
 * @param {object} opts
 * @param {() => void} opts.onAllClosed
 * @param {number} [opts.graceMs]
 * @param {Function} [opts.setTimer]    setTimeout, unless a test says otherwise
 * @param {Function} [opts.clearTimer]  clearTimeout, likewise
 */
export function createWindowWatch({ onAllClosed, graceMs = GRACE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let open = 0;
  let seen = false;
  let timer = null;
  let fired = false;

  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  return {
    opened() {
      open += 1;
      seen = true;
      cancel();
    },

    closed() {
      // Never below zero: a close arriving for a stream this watch never saw
      // opened (a reload racing a restart) must not bank a phantom window.
      open = Math.max(0, open - 1);
      if (open > 0 || !seen || fired || timer !== null) return;
      timer = setTimer(() => {
        timer = null;
        if (open === 0 && !fired) {
          fired = true;
          onAllClosed?.();
        }
      }, graceMs);
    },

    /** How many windows are open right now. */
    get open() {
      return open;
    },

    /** Whether a shutdown is currently counting down. */
    get pending() {
      return timer !== null;
    },
  };
}
