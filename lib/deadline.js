// Waiting for something for only so long.
//
// A promise raced against a timer that rejects with `timedOut: true`, and the
// timer cleared as soon as either side settles. The work itself is NOT
// cancelled - a fetch carries its own AbortSignal for that - so this is for the
// optional parts of an answer: the part the answer waits for is bounded here,
// and whatever arrives late is simply not used.

export function withinMs(promise, ms, what = "that") {
  let timer = null;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${what} took longer than ${ms} ms`);
      err.timedOut = true;
      reject(err);
    }, ms);
    // Deliberately NOT unref'd. The timer is what settles a promise that would
    // otherwise never settle, so it has to keep the event loop alive until it
    // fires - unref'd, a script waiting on a service that never answers simply
    // exits mid-await. It lives at most `ms`, and is cleared the moment the
    // work finishes first.
  });
  return Promise.race([Promise.resolve(promise), late]).finally(() => clearTimeout(timer));
}
