// Why the microphone did not open, in words somebody can act on.
//
// "He can't hear me" has five causes that look identical from outside the
// browser, and getUserMedia's own error names are not something to read aloud.
// This turns them into an instruction.
//
// The instruction has to match the WINDOW, which is the bug this module was
// extracted to fix. Greg opens Chrome with `--app=`, so his window has no
// address bar at all — and the blocked-microphone message told people to click
// the padlock in the address bar. There is no padlock. There is no address bar.
// The one message whose entire job is to get somebody out of a dead end sent
// them to a control that does not exist in the window they were looking at.
//
// Reported by somebody other than the author, again: the second time an install
// on a machine that was not this one found a fault no amount of local testing
// would have shown, because the author's window always had the permission
// already granted.
//
// Nothing here touches the DOM. Kept out of voice.js because Node cannot import
// that file at all — it reaches for `document` on its eleventh line — and a
// message that is the last thing standing between a user and a working
// microphone should not be the untested part of the system.

/**
 * Plain English for why the microphone did not open.
 *
 * `hasAddressBar` decides which remedy is even possible, and defaults to true
 * so a caller that forgets it gets the ordinary browser advice rather than the
 * app-window advice — being told about a padlock you do have is a smaller
 * failure than being told about one you do not.
 *
 * `origin` is only used in the app-window case, where the whole remedy is
 * "open this address somewhere with an address bar".
 */
export function micProblem(err, { hasAddressBar = true, origin = "" } = {}) {
  if (!err) return null;

  switch (err.name) {
    case "NotAllowedError":
    case "SecurityError":
      return hasAddressBar
        ? "Microphone blocked — click the padlock in the address bar, allow the microphone, then reload."
        : `Microphone blocked, and this window has no address bar to unblock it from. Open ${
            origin || "his address"
          } in an ordinary browser tab, allow the microphone there, then reload this window.`;

    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone found — plug one in, or check it's enabled in Windows sound settings, then reload.";

    case "NotReadableError":
      return "Windows wouldn't hand over the microphone — another program may have it. Close that and reload.";

    default:
      return `Microphone unavailable (${err.name}). Reload once you've sorted it and he'll pick it up.`;
  }
}

/**
 * Does this window have an address bar?
 *
 * `window.locationbar.visible` is the standard way to ask, and it is false in a
 * Chrome `--app=` window. Anything unexpected is treated as "yes", for the
 * reason above: the ordinary advice is the safer thing to be wrong about.
 */
export function hasAddressBar(win) {
  return win?.locationbar?.visible !== false;
}
