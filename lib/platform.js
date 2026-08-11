// What this operating system can and cannot do for Greg.
//
// Greg grew up on Windows and five modules shell out to PowerShell for things
// the web platform cannot reach: the screen, the cursor, the media session, the
// media keys and Windows' own voice. Everything else — the server, the brain,
// the tools, all fourteen channels, both Python sidecars — is plain Node and is
// already portable.
//
// **This file makes him BOOT honestly elsewhere. It does not port those five.**
// That distinction is the whole point. Each of them already catches a failed
// spawn and reports itself unavailable, so on Linux they degrade rather than
// crash — but they degrade SILENTLY, and a user who cannot see why "what's on
// my screen" does nothing has no way to find out. The banner says it now.
//
// Writing Linux implementations blind would be the thing this project spends
// its time removing: five modules I cannot run, shipped as "Linux support".
// Session eight found four real defects from one outside install, none of them
// reachable from the machine they were written on. So the honest version ships
// first, and somebody with a Linux desktop can send the five one at a time
// against a Greg that already runs.
//
// Kept as one file rather than lib/platform/{win32,linux}.js on purpose: there
// is only one implementation. A directory would imply the others exist.

export const IS_WINDOWS = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

/**
 * The five things that need PowerShell, what each costs, and the tool or
 * feature a user would notice missing.
 *
 * `wants` names what somebody would have to build. It is deliberately specific
 * — "MPRIS over D-Bus" is a first issue somebody can pick up, "port the media
 * session" is not.
 */
export const WINDOWS_ONLY = [
  {
    id: "screen",
    label: "screen vision",
    costs: "look_at_screen and take_screenshot",
    wants: "a capture via scrot, spectacle or the xdg-desktop-portal on Wayland",
  },
  {
    id: "cursor",
    label: "cursor tracking",
    costs: "his head following the pointer outside the browser window",
    wants: "xdotool getmouselocation on X11 — Wayland refuses this by design, so it cannot be done there at all",
  },
  {
    id: "nowplaying",
    label: "now playing",
    costs: "whats_playing and the Now Playing channel",
    wants: "MPRIS over D-Bus, which carries title, artist and art the same way",
  },
  {
    id: "media",
    label: "media keys",
    costs: "control_playback, so pause, skip and previous",
    wants: "playerctl play-pause / next / previous, which reaches any MPRIS player",
  },
  {
    id: "sapi",
    label: "the system voice",
    costs: "one of the fallback voices, if Piper ever fails",
    wants: "spd-say or espeak-ng",
  },
];

/**
 * What to say in the startup banner about this platform.
 *
 * Returns null on Windows — a line saying everything works is noise, and this
 * project's banner rule is that it reports what actually loaded rather than
 * reassuring you.
 */
export function platformNotice(platform = process.platform) {
  if (platform === "win32") return null;

  const name = platform === "linux" ? "Linux" : platform === "darwin" ? "macOS" : platform;
  return {
    platform: name,
    // Deliberately not phrased as an error. Nothing has gone wrong — these were
    // never written for this OS, and saying so plainly is different from
    // reporting a fault.
    headline: `${name}: brain, ears and voice work. ${WINDOWS_ONLY.length} Windows-only features are off.`,
    missing: WINDOWS_ONLY.map((f) => `${f.label} — ${f.costs}`),
    help: "These need PowerShell. See docs/linux.md for what each would take; contributions welcome.",
  };
}

/**
 * How to open a browser at `url`, as a command and arguments.
 *
 * Returns a spec rather than spawning, so the decision is testable without
 * launching anything — the same shape as cloneAction() in voices.js, which was
 * split for exactly this reason after a test spawned a real 4 GB sidecar.
 *
 * `appMode` is a Chrome flag that drops the address bar and makes Greg feel like
 * a desktop application rather than a tab. Worth keeping on Linux: the same
 * Chromium builds accept it under several binary names.
 */
export function browserCommand(url, { platform = process.platform, exists = () => false } = {}) {
  const appArgs = [`--app=${url}`, "--window-size=560,780"];

  if (platform === "win32") {
    const paths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    const found = paths.find(exists);
    return found
      ? { command: found, args: appArgs, appMode: true }
      : { command: "cmd", args: ["/c", "start", "", url], appMode: false };
  }

  if (platform === "darwin") {
    return { command: "open", args: [url], appMode: false };
  }

  // Linux and anything else that follows freedesktop conventions. Chromium goes
  // by several names depending on how it was packaged, so try them before
  // falling back to whatever the desktop has registered for http.
  const chromium = ["google-chrome", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"];
  const found = chromium.find(exists);
  return found
    ? { command: found, args: appArgs, appMode: true }
    : { command: "xdg-open", args: [url], appMode: false };
}

/**
 * Is `name` on PATH? Used to pick a browser on Linux, where binaries are on the
 * path rather than at a known absolute location.
 *
 * Synchronous and cheap — this runs once at startup. Deliberately does not
 * shell out: `which` is itself missing on minimal images.
 */
export function onPath(name, { env = process.env, exists, platform = process.platform } = {}) {
  if (typeof exists !== "function") return false;
  const listSep = platform === "win32" ? ";" : ":";
  const pathSep = platform === "win32" ? "\\" : "/";
  return String(env.PATH ?? "")
    .split(listSep)
    .filter(Boolean)
    .some((dir) => exists(dir.endsWith(pathSep) ? `${dir}${name}` : `${dir}${pathSep}${name}`));
}
