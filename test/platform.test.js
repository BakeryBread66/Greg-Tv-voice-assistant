// What Greg says about an operating system that is not Windows.
//
// Five modules shell out to PowerShell, and each already catches a failed spawn
// — so on Linux they degrade rather than crash. They degrade SILENTLY though,
// which is the actual problem: "what's on my screen" quietly does nothing and
// there is no way to find out why. These pin the wording that fixes that.
//
// The browser choice is tested as a SPEC rather than by launching anything, the
// same split cloneAction() got in voices.js after a test spawned a real 4 GB
// sidecar. `platform` and `exists` are both injected, so a Windows machine can
// prove the Linux behaviour — which is the only way any of this gets checked
// until somebody runs it on a Linux desktop.

import { test } from "node:test";
import assert from "node:assert/strict";

import { platformNotice, browserCommand, onPath, WINDOWS_ONLY } from "../lib/platform.js";

test("Windows gets no platform notice at all", () => {
  // The banner's rule is that it reports what actually loaded. A line saying
  // everything works is noise, and this project already deleted one boast that
  // was true in the normal case and a lie in the case that mattered.
  assert.equal(platformNotice("win32"), null);
});

test("Linux is told what is off, and that nothing is broken", () => {
  const notice = platformNotice("linux");

  assert.equal(notice.platform, "Linux");
  assert.match(notice.headline, /brain, ears and voice work/i, "lead with what DOES work");
  assert.equal(notice.missing.length, WINDOWS_ONLY.length, "every Windows-only feature is named");

  // Each line has to say the FEATURE and what it costs. "screen vision is off"
  // does not tell somebody why look_at_screen did nothing.
  for (const line of notice.missing) {
    assert.match(line, / — /, `"${line}" should name the feature and its cost`);
    assert.ok(line.length > 20, `"${line}" is too terse to act on`);
  }

  // Nothing has gone wrong. These were never written for this OS, and wording
  // it as a fault sends people debugging an install that is fine.
  assert.doesNotMatch(notice.headline, /error|fail|broken|problem/i);
  assert.match(notice.help, /docs\/linux\.md/, "point at the page that says what each would take");
});

test("macOS is named rather than lumped in with Linux", () => {
  // It is equally unported, and telling a Mac user "Linux" is the kind of small
  // lie that makes somebody distrust the rest of the banner.
  assert.equal(platformNotice("darwin").platform, "macOS");
  assert.equal(platformNotice("freebsd").platform, "freebsd");
});

test("every Windows-only entry says what building it would take", () => {
  // `wants` is what makes these a first issue rather than a complaint. It has to
  // name a tool somebody can go and read about.
  for (const feature of WINDOWS_ONLY) {
    assert.ok(feature.id && feature.label && feature.costs, `${feature.id} is missing a field`);
    assert.ok(feature.wants.length > 15, `${feature.id}: "${feature.wants}" is not actionable`);
  }

  // The one that cannot be done, and must not be promised. Wayland refuses
  // global cursor position as a security property — no amount of work brings
  // head tracking outside the window back there.
  const cursor = WINDOWS_ONLY.find((f) => f.id === "cursor");
  assert.match(cursor.wants, /wayland/i, "the Wayland limit belongs beside the cursor, not in a footnote");
});

test("the browser is chosen per platform, without launching one", () => {
  const url = "http://localhost:4747";

  // Windows: a known absolute path, in app mode — no address bar, which is what
  // makes Greg feel like a program rather than a tab.
  const win = browserCommand(url, { platform: "win32", exists: (p) => p.includes("chrome.exe") });
  assert.match(win.command, /chrome\.exe$/);
  assert.equal(win.appMode, true);
  assert.ok(win.args.includes(`--app=${url}`));

  // Windows with no Chrome or Edge found: hand it to the shell.
  const winBare = browserCommand(url, { platform: "win32", exists: () => false });
  assert.equal(winBare.command, "cmd");
  assert.equal(winBare.appMode, false);

  // Linux with a Chromium on PATH: same app mode, different binary name.
  const linux = browserCommand(url, { platform: "linux", exists: (p) => p === "chromium" });
  assert.equal(linux.command, "chromium");
  assert.equal(linux.appMode, true);

  // Linux with none of them: xdg-open, which is the freedesktop way to say
  // "whatever this desktop registered for http".
  const linuxBare = browserCommand(url, { platform: "linux", exists: () => false });
  assert.equal(linuxBare.command, "xdg-open");
  assert.equal(linuxBare.appMode, false);

  // macOS has `open` and no xdg-open at all — reaching for xdg-open there is the
  // easy mistake, and it fails with a message about nothing in particular.
  assert.equal(browserCommand(url, { platform: "darwin", exists: () => false }).command, "open");
});

test("appMode is reported, because it changes the microphone advice", () => {
  // public/mic-help.js tells a blocked user to click the padlock in the address
  // bar. In app mode there IS no address bar — the note beside hasAddressBar()
  // says so — so whether we launched that way is a fact the caller needs.
  const url = "http://x";
  assert.equal(browserCommand(url, { platform: "linux", exists: () => true }).appMode, true);
  assert.equal(browserCommand(url, { platform: "linux", exists: () => false }).appMode, false);
});

test("onPath splits PATH the way the platform does", () => {
  const seen = [];
  const exists = (p) => { seen.push(p); return p === "/usr/bin/chromium"; };

  assert.equal(onPath("chromium", { platform: "linux", env: { PATH: "/bin:/usr/bin" }, exists }), true);
  assert.ok(seen.includes("/usr/bin/chromium"), "joined with a forward slash");

  // Windows uses ; between entries and \ within them. Getting this backwards
  // finds nothing and silently falls through to the shell.
  const winSeen = [];
  onPath("chrome.exe", {
    platform: "win32",
    env: { PATH: "C:\\Windows;C:\\Tools" },
    exists: (p) => { winSeen.push(p); return false; },
  });
  assert.deepEqual(winSeen, ["C:\\Windows\\chrome.exe", "C:\\Tools\\chrome.exe"]);

  // No PATH, no exists, an empty PATH: all absence, none of it a crash. This
  // runs at startup and a throw here would cost the browser opening at all.
  assert.equal(onPath("x", { platform: "linux", env: {}, exists }), false);
  assert.equal(onPath("x", { platform: "linux", env: { PATH: "" }, exists }), false);
  assert.equal(onPath("x", { platform: "linux", env: { PATH: "/bin" } }), false, "no exists() is not a crash");
});
