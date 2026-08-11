// Greg's ears and mouth.
//
// Listens continuously for the wake word using the browser's speech recognition,
// sends what you said to the server, then plays back his answer while driving
// the face animation from the audio itself.

import { createFace } from "./face.js";
import { LocalListener } from "./listen-local.js";
import { initSettings, paintSettings } from "./settings.js";
import { normalize, afterWakeWord as matchWakeWord, isFiller, isCancel, isReplay } from "./wake.js";
import { createVocoder } from "./vocoder.js";
import { clampVolume, stepVolume, volumeLabel } from "./volume.js";
import { playEarcon, playStrike, playPost, tubeWhine } from "./earcon.js";
import { micProblem as micProblemFor, hasAddressBar } from "./mic-help.js";

const el = {
  canvas: document.getElementById("face"),
  status: document.getElementById("status"),
  you: document.getElementById("you"),
  greg: document.getElementById("greg"),
  input: document.getElementById("input"),
  overlay: document.getElementById("overlay"),
  wakeBtn: document.getElementById("wake-btn"),
  hint: document.getElementById("hint"),
  micBtn: document.getElementById("mic-btn"),
  resetBtn: document.getElementById("reset-btn"),
  globeBtn: document.getElementById("globe-btn"),
  musicBtn: document.getElementById("music-btn"),
  channelBtn: document.getElementById("channel-btn"),
  volumeBtn: document.getElementById("volume-btn"),
  eyesBtn: document.getElementById("eyes-btn"),
  gamingBtn: document.getElementById("gaming-btn"),
  badge: document.getElementById("badge"),
};

// Top-level await: the 3D renderer is loaded on demand, and everything below
// depends on having a face to talk to.
const rendering = await createFace(el.canvas, new URLSearchParams(location.search).get("face") ?? "auto");
const face = rendering.face;
el.canvas = rendering.canvas; // may have been swapped if WebGL failed

let config = { name: "Greg", wakeWords: ["hey greg"], hasBrain: false };
let mode = "off"; // off | idle | armed | thinking | speaking
let recognition = null;
let wantListening = false;
let restartTimer = null;
let armedTimer = null;
let micEnabled = true;
let consecutiveErrors = 0;
let offline = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let events = null;
let announcing = false;
const announcements = [];
let localListener = null;
let micStream = null;
let micError = null; // why getUserMedia failed, if it did — see micProblem()
let micFellBack = false; // the saved device was gone and we opened the default

// Which microphone to open, from /api/settings.
//
// Deliberately its own variable rather than config.listening.deviceId: in the
// BROWSER, `config.listening` is the string "local" or "browser" from
// /api/config — the listening PATH, not the listening settings, which are a
// different shape under the same name on the server. Reading `.deviceId` off a
// string returns undefined silently, which is how this would have looked like it
// worked while always opening the default device.
let micDeviceId = "";

// How loud counts as speech, from /api/settings — and its own variable for
// EXACTLY the same reason as micDeviceId above, which is the trap this pair
// walked into second.
//
// startLocalListening() used to read `config.listening?.floorMultiple`, which is
// undefined for the reason described above, so LocalListener always fell back to
// its built-in 3.5 / 0.012. adoptSettings() does push the real values in, but it
// runs BEFORE the listener exists — its `if (localListener)` guard skips — so
// the configured numbers reached it only if you opened Settings and pressed
// Apply during a session, and were silently lost on the next restart.
//
// It was invisible because the built-in fallbacks are the same two numbers as
// the shipped config. Change the slider and restart and it reverts, which is a
// worse kind of broken than a control that never works: this one works until
// you stop looking.
let micLevels = { floorMultiple: 3.5, minLevel: 0.012 };

let transcribing = false;
let listeningForFollowUp = false;
let bargeTimer = null;
let bargeInDisabled = false; // tripped by the runaway guard below
let earlyBargeIns = 0;
let speakingSince = 0;
let askGeneration = 0; // bumped to abandon an answer that was interrupted
let chatAbort = null;
// The last answer's audio, so "what?" replays it instead of asking again.
let replayClips = [];
// The voice treatment, and the settings it is currently obeying. Kept as its own
// variable rather than read off config for the reason listening levels are:
// config.vocoder is a server-side shape and this page has its own copy.
let vocoder = null;
let vocoderSettings = { enabled: false, amount: 0.6 };

// How loud he is, 0..1, and the gain node every sound he makes passes through.
// Its own variable for the same reason micDeviceId and micLevels are: `config`
// in the browser is the /api/config shape, which has no volume in it, and
// reading a field that is not there returns undefined in silence.
//
// Remembered even before there is a graph to push it into, because the value
// arrives from /api/settings in wake() and the graph is built by setupAudio()
// afterwards — the mic thresholds were silently lost on every restart for
// exactly this ordering, and this is that trap avoided rather than repeated.
let volume = 1;
let voiceGain = null;
let volumeAdopted = false; // the saved value has been taken on at least once

// Resolves once /api/settings has been read and adopted. The warm-up's sounds
// wait on it so a muted set starts up silently; the warm-up's PICTURE does not,
// because making it wait is what stopped the boot sequence appearing at all.
let settingsReady = Promise.resolve();

// The last moment we saw any sign of life. Feeds awaySeconds on the next
// question, so Greg can notice you have been gone — see lib/presence.js.
// The gap is captured when activity RESUMES, not when the question is asked.
// Coming back to the machine means touching the mouse, which would otherwise
// reset the clock a second before you spoke — the counter would read zero every
// time and the feature would never once fire.
let lastSeenAt = Date.now();
let pendingAbsence = 0;

const seen = () => {
  const gap = (Date.now() - lastSeenAt) / 1000;
  // Keep the longest gap since the last question, so a stray mouse twitch on the
  // way back doesn't overwrite the hour that came before it.
  if (gap > 60) pendingAbsence = Math.max(pendingAbsence, gap);
  lastSeenAt = Date.now();
};

// Reading it consumes it: an absence is worth mentioning once, not for the rest
// of the conversation.
const awaySeconds = () => {
  const away = Math.round(pendingAbsence);
  pendingAbsence = 0;
  return away;
};

for (const ev of ["pointermove", "pointerdown", "keydown", "wheel"]) {
  window.addEventListener(ev, seen, { passive: true });
}

let audioCtx = null;
let micAnalyser = null;
let voiceAnalyser = null;
let spectrum = null;
let endSpeech = null; // resolves the in-flight speak() when interrupted
const player = new Audio();
player.preload = "auto";

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/**
 * Is the microphone ACTUALLY being listened to, right now?
 *
 * Not the same question as `micEnabled`, which is only whether the user has
 * muted it. Capture can be off while everything looks healthy: the page was
 * reloaded and never woken, the server restarted and left it disabled, or
 * something threw between acquiring the stream and arming it.
 */
const listeningNow = () => wantListening && (localListener ? localListener.enabled : Boolean(recognition));

const STATUS = {
  off: () => "Tap to wake",
  // The idle line used to promise "Say Hey Greg" unconditionally, which made a
  // page that had stopped listening indistinguishable from one that hadn't —
  // and that is precisely the state a Greg restart used to leave it in. If he
  // cannot hear you, the one line you are looking at should be the thing that
  // says so.
  idle: () =>
    !micEnabled
      ? "Microphone off — type below"
      : listeningNow()
        ? `Say “Hey ${config.name}”`
        : "Not listening — reload the page and click Wake",
  armed: () => "Listening…",
  thinking: () => "Thinking…",
  speaking: () => "Speaking…",
  offline: () => "Offline — Greg has been shut down",
};

// Thrown when the server can't be reached at all, as opposed to the server
// answering with an error. The difference matters: if Greg has been shut down
// he must go quiet, not announce the failure out loud.
class ServerDown extends Error {}

async function serverFetch(path, options) {
  try {
    return await fetch(path, options);
  } catch (err) {
    // Cancelling a request on purpose is not the server going away, and must not
    // be mistaken for it — that would send the page offline mid-conversation.
    if (err.name === "AbortError") throw err;
    throw new ServerDown();
  }
}

function setMode(next) {
  mode = next;
  el.status.textContent = STATUS[next]?.() ?? "";
  document.body.dataset.mode = next;
  face.setState(next === "off" || next === "idle" ? "idle" : next === "armed" ? "listening" : next);
}

function showYou(text) {
  el.you.textContent = text ? `“${text}”` : "";
  el.you.classList.toggle("visible", Boolean(text));
}

function showGreg(text) {
  el.greg.textContent = text ?? "";
  el.greg.classList.toggle("visible", Boolean(text));
}

function flashError(message) {
  face.setState("error");
  el.status.textContent = message;
  setTimeout(() => setMode("idle"), 2600);
}

// ---------------------------------------------------------------------------
// Going offline when the server stops
//
// Speech recognition runs entirely in the browser, so closing Greg's server
// doesn't stop this page listening. Without this, saying "Hey Greg" to a shut-
// down Greg produced a failed request, which became an error message, which got
// read aloud by the browser's own voice — Greg talking after being switched off.
// ---------------------------------------------------------------------------

function goOffline() {
  if (offline) return;
  offline = true;

  abandonAnswer();         // cut off anything mid-sentence, and stop the stream
  wantListening = false;   // and stop the microphone
  stopListening();
  clearTimeout(armedTimer);
  clearTimeout(restartTimer);

  setMode("offline");
  face.setState("error");
  el.badge.textContent = "offline";
  el.badge.classList.add("warn");
  el.hint.textContent = "Greg's server has stopped. Run start-greg.bat and this page will reconnect on its own.";
  showYou("");

  clearInterval(reconnectTimer);
  reconnectTimer = setInterval(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) comeOnline();
    } catch {
      // still down — keep waiting
    }
  }, 4000);
}

async function comeOnline() {
  clearInterval(reconnectTimer);
  offline = false;

  try {
    config = await (await fetch("/api/config")).json();
    if (config.desktop) document.documentElement.style.setProperty("--desktop", config.desktop);
    // Optional extra beyond the four methods every face must have — guarded, so
    // a renderer that doesn't show a clock simply doesn't get told about one.
    face.setUptimeStart?.(config.startedAt);
  } catch {
    /* keep what we had */
  }

  el.badge.textContent = config.hasBrain ? `${config.location?.city ?? ""}`.trim() || "online" : "basic mode";
  el.badge.classList.toggle("warn", !config.hasBrain);
  el.hint.textContent = `Say “Hey ${config.name}”, then ask for the weather or the local news.`;

  setMode("idle");

  // BOTH listening paths have to be restored, not just the browser one.
  //
  // `recognition` is null whenever the offline Whisper ears are in use, which is
  // the normal case on this machine — so this test was false every single time
  // and an open page stopped listening PERMANENTLY the moment Greg restarted.
  // goOffline() had set wantListening = false and disabled capture; nothing ever
  // undid it, and the page went on saying "Say Hey Greg" with the microphone
  // switched off. Reloading fixed it, which is why it looked intermittent and
  // unrelated to anything.
  //
  // startListening() already knows how to start either one; it just has to be
  // allowed to run.
  if (micEnabled && (localListener || recognition)) {
    wantListening = true;
    // A tab backgrounded while the server was away can come back with the
    // AudioContext suspended. The worklet then delivers no frames, the level
    // meter sits at zero, and the microphone looks broken with nothing to say
    // why — which is indistinguishable from a dead device from the outside.
    audioCtx?.resume?.().catch(() => {});
    startListening();
    console.log(`[ears] reconnected — listening again (${localListener ? "offline" : "browser"})`);
  } else if (micEnabled) {
    // Nothing to restart means the page has audio set up for neither path —
    // normally because it was reloaded and never woken. Say so rather than
    // leaving "Say Hey Greg" on screen over a microphone that isn't running.
    el.hint.textContent = `Reconnected, but the microphone isn't running — reload and click Wake ${config.name}.`;
    console.warn("[ears] reconnected with no listener — the page needs waking");
  }
}

// ---------------------------------------------------------------------------
// Timers and reminders arriving from the server
// ---------------------------------------------------------------------------

function connectEventStream() {
  if (events) events.close();
  events = new EventSource("/api/events");

  events.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.type === "reminder") {
      // A late one names the time it was actually due. "Take your medicine"
      // hours after the fact, with no indication it is late, is a prompt to take
      // a dose you may already have taken — the time is the part that makes it
      // safe to act on.
      const lead = payload.late
        ? `While you were away, at ${payload.dueAtLocal ?? "earlier"}: `
        : "";
      const body = payload.kind === "timer" ? `time's up for ${payload.text}` : payload.text;
      queueAnnouncement(`${lead}${body}.`);
    }
    // The globe window asked for somewhere to be read out. It goes through the
    // same queue as a reminder, so it waits its turn rather than talking over
    // an answer already in progress.
    // `tone` is absent for an ordinary reading and "alert" for a severe weather
    // warning, which gets the attention signal instead of the station ident. The
    // server decides, because this end sees only a string.
    if (payload.type === "say" && payload.text) queueAnnouncement(payload.text, payload.tone);

    // A switch thrown by voice has to move the button too, or the two disagree
    // about whether the eyes are open and the face starts lying about it.
    if (payload.type === "power" && payload.state) paintPower(payload.state);

    // Same for the channel: "put the album art up" said out loud has to move the
    // knob on the cabinet, and the knob has to move what the model thinks it is
    // showing. Both go through lib/channels.js, and this is how the face hears.
    if (payload.type === "channel" && payload.state) paintChannel(payload.state);

    // A weather warning has just put itself on the screen. The server has
    // already switched the channel and cleared its cache, but this page is on
    // its own timer — without a nudge it would show a weather card with no
    // warning on it for up to a minute, while Greg reads the warning out loud.
    // The picture and the voice disagreeing is the one thing an alert cannot do.
    if (payload.type === "alert") refreshFeed();

    // Settings changed — possibly in another window, possibly by voice moving a
    // personality dial. Repaint the dialog and take on the ones this page is
    // responsible for enforcing.
    if (payload.type === "settings" && payload.state) {
      paintSettings(payload.state);
      adoptSettings(payload.state);
    }
  });

  // EventSource reconnects on its own; the heartbeat owns offline detection.
  events.addEventListener("error", () => {});
}

function queueAnnouncement(text, tone = "ident") {
  announcements.push({ text, tone });
  drainAnnouncements();
}

async function drainAnnouncements() {
  // Wait rather than talk over an answer in progress.
  if (announcing || offline || !announcements.length) return;
  if (mode === "thinking" || mode === "speaking") {
    setTimeout(drainAnnouncements, 1200);
    return;
  }

  announcing = true;
  const { text, tone } = announcements.shift();

  stopListening(); // don't let Greg hear his own alert
  showGreg(text);
  await chime(tone);
  await speak(text);

  announcing = false;
  if (!offline) {
    setMode("idle");
    if (micEnabled) startListening();
  }
  if (announcements.length) drainAnnouncements();
}

// ---------------------------------------------------------------------------
// The sounds the set makes
//
// Two earcons, synthesised rather than shipped as audio files — for the same
// reason the face is drawn rather than animated: nothing to download, nothing to
// go missing, and the volume knob can reach them.
//
// They live in public/earcon.js, next to the vocoder and for the same reason:
// the graph needs a browser but the numbers do not, so what is actually in them
// can be rendered offline and measured. Nothing about them is decided here.
// ---------------------------------------------------------------------------

/**
 * Play the earcon that precedes an announcement, and resolve when it is done.
 *
 * Routed through voiceGain, so the knob on the cabinet turns the chime down
 * exactly as it turns his voice down. Falls back to the destination if the graph
 * has not been built yet — the same reasoning as createVocoder() returning null:
 * a missing piece must cost the effect, not the announcement.
 */
function chime(kind = "ident") {
  if (!audioCtx) return Promise.resolve();
  return playEarcon(audioCtx, voiceGain ?? audioCtx.destination, kind);
}

// The set warming up: the thunk as the tube strikes, the line whine while it is
// on, and the POST beep when the device list finishes — one beep for a clean
// machine, two for a degraded one, the way a real BIOS says so.
//
// On the volume bus like everything else, so a muted Greg starts up silently.
// Held here rather than in the face because the face draws and does not own the
// audio graph; it hands the beats over and forgets about them.
let whine = null;

/**
 * Make the noise for one beat of the warm-up.
 *
 * Everything here is deferred behind `settingsReady` and wrapped in a catch, and
 * both halves matter. The saved VOLUME arrives with those settings, so playing
 * before they land means a set somebody muted makes a noise anyway — but the
 * picture must not wait for them, so the sound waits instead. A few milliseconds
 * late is imperceptible on a thunk.
 *
 * And nothing in here may reach the caller. This is called from the render loop,
 * on the path that ends with the microphone opening; the first version built the
 * audio context inside the try-block that guards the boot, which made a speaker
 * problem able to cost the whole warm-up. **An effect failing must cost the
 * effect.**
 */
function bootSound(beat, sequence) {
  settingsReady
    .then(() => playBootBeat(beat, sequence))
    .catch((err) => console.warn(`[boot] no sound for "${beat}":`, err.message));
}

function playBootBeat(beat, sequence) {
  const ctx = primeAudio();
  const out = voiceGain ?? ctx.destination;

  if (beat === "strike") playStrike(ctx, out);
  // The whine starts when the picture opens, not when the tube strikes: the
  // line output transformer is what makes it, and it is not running yet while
  // the beam is still a bright line across the middle.
  else if (beat === "open") whine ??= tubeWhine(ctx, out);
  else if (beat === "post") playPost(ctx, out, { devices: sequence?.devices ?? [] });

  // "end" covers finishing AND being skipped by a click, which is the case that
  // matters: a 15 kHz tone left running after somebody cut the warm-up short
  // would be an invisible fault that some people can hear and others cannot.
  if (beat === "end") {
    whine?.stop();
    whine = null;
  }
}

// Notice a shutdown even when you're not talking to him.
/**
 * Tell the server where this window is on the desktop.
 *
 * screenX/screenY are in the same virtual-desktop coordinates the screen
 * capture reports its bounds in, so the two can be compared exactly — which is
 * what lets Greg say whether he was actually in shot instead of guessing. Sent
 * on the heartbeat rather than on a timer of its own: windows do not move often,
 * and there is already a beat to hang it on.
 */
function reportWindow() {
  fetch("/api/window", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      x: window.screenX,
      y: window.screenY,
      w: window.outerWidth,
      h: window.outerHeight,
      hidden: document.hidden,
    }),
  }).catch(() => {});
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  reportWindow();
  heartbeatTimer = setInterval(async () => {
    if (offline || mode === "thinking" || mode === "speaking") return;
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) throw new Error("unhealthy");
      reportWindow();
    } catch {
      goOffline();
    }
  }, 10000);
}

// ---------------------------------------------------------------------------
// Wake word matching
// ---------------------------------------------------------------------------

// The matching itself lives in wake.js so it can be proven in Node — this is the
// one line that knows where the wake words come from.
const afterWakeWord = (transcript) => matchWakeWord(transcript, config.wakeWords);

// ---------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function buildRecognition() {
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  rec.maxAlternatives = 1;

  rec.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript;

      if (!result.isFinal) {
        // Light up the moment the wake word appears, before he's finished talking.
        if (mode === "idle" && afterWakeWord(transcript) !== null) arm();
        continue;
      }

      handleFinal(transcript);
    }
  };

  rec.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return; // routine
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      wantListening = false;
      micEnabled = false;
      updateMicButton();
      flashError("Microphone blocked — allow access and reload");
      return;
    }
    consecutiveErrors++;
    if (consecutiveErrors > 5) {
      wantListening = false;
      flashError("Speech recognition keeps failing — check your connection");
    }
  };

  rec.onend = () => {
    // Chrome stops recognition on its own every so often; just start it again.
    if (!wantListening || mode === "speaking" || mode === "thinking") return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(startListening, 300);
  };

  return rec;
}

function startListening() {
  if (!wantListening) return;

  if (localListener) {
    localListener.enable();
  } else if (recognition) {
    try {
      recognition.start();
      consecutiveErrors = 0;
    } catch {
      // Already running — harmless.
    }
  } else {
    return;
  }

  // The idle status line now reports whether capture is genuinely armed, and
  // almost every caller sets the mode BEFORE calling this — so without a refresh
  // here the line would read "Not listening" for the rest of the session even
  // though listening had just started. Ordering shouldn't be load-bearing.
  if (mode === "idle") el.status.textContent = STATUS.idle();
}

function stopListening() {
  // Always disable local capture, even mid-utterance: this is what stops Greg
  // transcribing his own voice while he speaks.
  localListener?.disable();

  if (!recognition) return;
  try {
    recognition.stop();
  } catch {}
}

// ---------------------------------------------------------------------------
// Offline listening (local Whisper)
// ---------------------------------------------------------------------------

async function startLocalListening() {
  if (!micStream || !audioCtx) return false;

  try {
    localListener = new LocalListener({
      audioCtx,
      stream: micStream,
      // From micLevels, NOT config.listening — see the note by its declaration.
      floorMultiple: micLevels.floorMultiple,
      minLevel: micLevels.minLevel,
      onActivity: (speaking) => {
        // Light the face up while you're actually talking.
        if (speaking && mode === "idle") face.setState("listening");
        else if (!speaking && mode === "idle") face.setState("idle");

        // Talking over him is how you interrupt him.
        if (speaking && mode === "speaking") watchForBargeIn();
        else if (!speaking) clearTimeout(bargeTimer);
      },
      onUtterance: (wav) => handleUtterance(wav),
    });
    await localListener.start();
    return true;
  } catch (err) {
    console.warn("local listening unavailable:", err.message);
    localListener = null;
    return false;
  }
}

async function handleUtterance(wav) {
  // One at a time, and never while Greg is thinking or speaking.
  if (transcribing || offline || mode === "thinking" || mode === "speaking" || announcing) return;
  transcribing = true;

  try {
    const res = await serverFetch("/api/transcribe", { method: "POST", body: wav });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "transcription failed");

    const text = (data.text ?? "").trim();
    // Kept for the ?mic readout. This is the step nothing could see before: an
    // utterance that reaches Whisper and comes back empty, and one that comes
    // back as words the wake matcher then rejects, are completely different
    // faults that both present as "he ignored me".
    lastHeard = text || "(empty)";
    lastHeardAt = Date.now();
    if (micDebug) console.log(`[mic] whisper heard: "${text}"`);
    if (text) handleFinal(text);
  } catch (err) {
    if (err instanceof ServerDown) goOffline();
    else console.warn("transcription failed:", err.message);
  } finally {
    transcribing = false;
  }
}

// The filler guard is applied inside the follow-up window only — say the wake
// word and it does not apply. `isFiller` itself is in wake.js, with its battery.

/**
 * Open the listening window.
 *
 * `followUp` marks the window as one Greg opened himself after answering, rather
 * than one you opened by saying his name — which is what the filler guard keys off.
 */
// ---------------------------------------------------------------------------
// Barge-in — cutting him off by talking
//
// The detection is borrowed rather than invented: LocalListener already tracks a
// rolling noise floor and reports when you start talking, so this reuses that
// judgement instead of guessing at a microphone level that would be wrong in
// every room but one.
//
// It requires local ears. Browser speech recognition is stopped while Greg
// talks, so there's nothing listening to interrupt him with.
// ---------------------------------------------------------------------------

function bargeInReady() {
  return Boolean(localListener) && !bargeInDisabled && (config.bargeIn?.enabled ?? true);
}

// Wait for the speech to hold before acting — a cough or a chair creak shouldn't
// stop him mid-sentence.
//
// The test is sustainedLoudFor(), NOT `speaking`. `speaking` stays true for
// 0.85 s after the last loud frame, so testing it after a 350 ms wait was
// satisfied by any single blip — one keystroke, one "mm", one chair creak would
// cut him off, and no amount of raising sustainMs below 850 ms could have helped.
function watchForBargeIn() {
  if (!bargeInReady()) return;
  clearTimeout(bargeTimer);
  const sustainMs = config.bargeIn?.sustainMs ?? 600;
  bargeTimer = setTimeout(() => {
    if (mode !== "speaking") return;
    const heldMs = (localListener?.sustainedLoudFor() ?? 0) * 1000;
    // Allow a frame's slack: the check lands a tick after the timer.
    if (heldMs >= sustainMs * 0.9) interrupt();
  }, sustainMs);
}

/**
 * Drop the answer in progress: stop the audio, stop the queue, and stop the
 * server still writing it.
 *
 * Cutting the audio alone isn't enough once replies stream — generation would
 * carry on and the next sentence would arrive and start playing, so he'd pick
 * himself back up a second after being told to stop.
 */
function abandonAnswer() {
  askGeneration++;
  chatAbort?.abort();
  chatAbort = null;
  stopSpeaking();
}

function interrupt() {
  if (mode !== "speaking") return;

  // Safety valve. With headphones Greg's voice never reaches the microphone, but
  // on speakers it does, and he would interrupt himself the instant he started
  // talking — every single reply, unusable. Rather than making the user work out
  // why, notice the pattern and stand down.
  if (Date.now() - speakingSince < 1200) {
    if (++earlyBargeIns >= 3) {
      bargeInDisabled = true;
      console.warn("Barge-in kept triggering the moment Greg spoke — disabling it for this session. Use headphones, or set bargeIn.enabled to false in config.json.");
      el.hint.textContent = "Barge-in turned itself off — Greg was hearing his own voice. Use headphones, or click his face to interrupt.";
      return;
    }
  } else {
    earlyBargeIns = 0;
  }

  abandonAnswer();

  // Straight back to listening: you interrupted because you had something to say.
  // Not marked as a follow-up window — the filler guard exists for speech that
  // might not have happened, and here the microphone just proved that it did.
  setMode("idle");
  startListening();
  arm({ seconds: config.followUp?.seconds ?? 7 });
}

function arm({ seconds = 9, followUp = false } = {}) {
  if (mode !== "idle" && mode !== "armed") return;
  setMode("armed");
  listeningForFollowUp = followUp;
  if (followUp) el.status.textContent = "Still listening…";

  clearTimeout(armedTimer);
  armedTimer = setTimeout(() => {
    listeningForFollowUp = false;
    if (mode === "armed") {
      setMode("idle");
      showYou("");
    }
  }, seconds * 1000);
}

function handleFinal(transcript) {
  if (offline) return;
  const said = normalize(transcript);
  if (!said) return;

  if (mode === "idle") {
    const remainder = afterWakeWord(transcript);
    if (remainder === null) return; // not for Greg

    if (remainder.split(" ").filter(Boolean).length >= 1) {
      ask(remainder);
    } else {
      arm(); // just "Hey Greg" — wait for the actual question
    }
    return;
  }

  if (mode === "armed") {
    // Allow "hey greg, <question>" said as one phrase too.
    const remainder = afterWakeWord(transcript);
    const question = remainder !== null && remainder ? remainder : said;

    // Checked before the timer is cleared, so ignoring a cough doesn't leave the
    // window propped open for good.
    if (listeningForFollowUp && remainder === null && isFiller(question)) return;

    clearTimeout(armedTimer);
    listeningForFollowUp = false;

    if (isCancel(question)) {
      setMode("idle");
      showYou("");
      return;
    }
    ask(question);
  }
}

// ---------------------------------------------------------------------------
// Asking and answering
// ---------------------------------------------------------------------------

// Reads an SSE body as a sequence of parsed events. EventSource can't POST, so
// the stream is consumed by hand.
async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line.
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          yield JSON.parse(line.slice(5).trim());
        } catch {
          // A malformed frame isn't worth abandoning the answer over.
        }
      }
    }
  }
}

/**
 * Play the last answer's audio again, if we still have it.
 *
 * Goes back through the normal speech queue rather than playing the blobs
 * directly, so the gap between sentences, the face, barge-in and interrupting
 * all behave exactly as they did the first time. Returns false when there is
 * nothing to replay, and the caller falls through to the model — "what?" said
 * before he has ever spoken is a question, not a request for an encore.
 */
function replayLast() {
  const clips = replayClips.filter((clip) => clip.gen === askGeneration);
  if (!clips.length) return false;

  for (const clip of clips) {
    speech.items.push({ text: clip.text, audio: Promise.resolve(clip.blob), done: () => {}, cached: true });
  }
  drainSpeech();
  return true;
}

async function ask(text) {
  if (offline) return;

  // Before the generation is bumped, because the clips are tagged with it.
  if (isReplay(normalize(text)) && replayLast()) {
    showYou(text);
    return;
  }

  clearTimeout(armedTimer);
  stopListening();
  setMode("thinking");
  showYou(text);
  showGreg("");

  const generation = ++askGeneration;
  const abandoned = () => generation !== askGeneration;

  const spoken = [];
  const heard = [];
  let reply = "";

  chatAbort = new AbortController();

  try {
    const res = await serverFetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, awaySeconds: awaySeconds() }),
      signal: chatAbort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`server error ${res.status}`);

    for await (const event of readEvents(res.body)) {
      if (abandoned()) return; // you cut in; this answer is no longer wanted
      if (event.type === "sentence") {
        // Say it and show it as it lands, rather than waiting for the full answer.
        heard.push(event.text);
        showGreg(heard.join(" "));
        spoken.push(speak(event.text));
      } else if (event.type === "done") {
        reply = event.reply ?? heard.join(" ");
      }
    }
  } catch (err) {
    // Interrupting aborts the request, which lands here. That isn't a failure and
    // must not be announced — you cut him off on purpose.
    if (abandoned() || err.name === "AbortError") return;
    // Greg was shut down: go quiet rather than narrating the failure.
    if (err instanceof ServerDown) return goOffline();
    // The answer may have been cut off partway; say the failure, not the fragment.
    stopSpeaking();
    reply = `Something went wrong on my end. ${err.message}`;
    showGreg(reply);
    spoken.length = 0;
    spoken.push(speak(reply));
  } finally {
    chatAbort = null;
  }

  if (reply) showGreg(reply);
  await Promise.all(spoken);

  if (abandoned()) return; // interrupted while the last sentence was playing
  if (offline) return; // the server dropped mid-answer; stay quiet
  setMode("idle");
  if (!micEnabled) return;

  startListening();

  // Stay open for a few seconds so a follow-up doesn't need the wake word again.
  // Conversations are rarely one question long, and "Hey Greg" before every
  // sentence is the thing that makes a voice assistant feel like a vending machine.
  const followUp = config.followUp ?? {};
  if (followUp.enabled !== false) arm({ seconds: followUp.seconds ?? 7, followUp: true });
}

// ---------------------------------------------------------------------------
// Speaking
//
// A queue rather than a single call, so Greg can start saying sentence one while
// sentence three is still being written. Two rules keep it from sounding wrong:
// clips play strictly in the order they were queued, and synthesis runs a little
// ahead of playback so there's no gap between them.
// ---------------------------------------------------------------------------

// How many sentences to synthesize ahead of the one being played. Two is enough
// to cover the gap; more just wastes work when you interrupt him.
const PREFETCH = 2;

// A short settle before the next clip. "ended" fires when the media element runs
// out of buffer, but the audio graph it feeds (source -> analyser -> output) is
// still draining, so starting immediately overlaps the tail of the sentence
// you just heard. It doubles as the pause a person leaves between sentences.
const SENTENCE_GAP_MS = 110;

const speech = {
  items: [], // { text, audio: Promise<Blob>|null, done: () => void }
  draining: false,
  generation: 0, // bumped to abandon everything queued and in flight
};

function synthesizeSentence(text) {
  return serverFetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, awaySeconds: awaySeconds() }),
  }).then((res) => {
    if (!res.ok) throw new Error(`speech service unavailable (${res.status})`);
    return res.blob();
  });
}

// Start synthesis for the next few unstarted items. Called whenever the queue
// changes, so the pipeline stays full as clips are consumed.
function primeSpeech() {
  let inFlight = 0;
  for (const item of speech.items) {
    if (item.audio) {
      inFlight++;
      continue;
    }
    if (inFlight >= PREFETCH) break;
    item.audio = synthesizeSentence(item.text);
    inFlight++;
  }
}

/** Queue one sentence. Resolves when it has finished playing (or been cut off). */
function speak(text) {
  const clean = String(text ?? "").trim();
  if (!clean) return Promise.resolve();

  return new Promise((resolve) => {
    speech.items.push({ text: clean, audio: null, done: resolve });
    primeSpeech();
    drainSpeech();
  });
}

// Tell the server when he starts and stops talking, so music can get out of the
// way. Fire-and-forget on purpose: Spotify being slow must never delay speech.
function announceSpeaking(speaking) {
  fetch("/api/speaking", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speaking }),
  }).catch(() => {});
}

async function drainSpeech() {
  if (speech.draining) return;
  speech.draining = true;
  announceSpeaking(true);
  const generation = speech.generation;

  try {
    while (speech.items.length && generation === speech.generation) {
      const item = speech.items[0];
      primeSpeech(); // keep the next ones synthesizing while this one plays

      let blob = null;
      try {
        blob = await item.audio;
      } catch (err) {
        // Server gone: go quiet rather than narrating the failure. Anything else
        // means Greg is alive but his voice isn't, so use the browser's.
        if (err instanceof ServerDown) {
          goOffline();
          return;
        }
        blob = null;
      }

      // An interruption while that was in flight — drop it rather than talk over
      // whatever replaced it.
      if (generation !== speech.generation) return;

      speech.items.shift();

      // Keep what was actually said, so "what?" can replay the audio rather
      // than re-running the model — which would produce a different sentence,
      // and a different sentence is not what "say that again" asks for.
      // `cached` items came FROM a replay; re-capturing them would grow the
      // list every time you asked twice.
      if (blob && !item.cached) {
        replayClips.push({ text: item.text, blob, gen: askGeneration });
        if (replayClips.length > 12) replayClips.shift();
      }

      // Page 888. Set per sentence, which is the seam that already existed —
      // and set for BOTH paths, because the browser's own voice is the one most
      // likely to be missing something worth reading.
      face.setSpeech?.(item.text);

      if (blob) await playClip(blob);
      else await browserSpeak(item.text);
      item.done();

      // Let the tail drain before the next sentence starts on top of it.
      if (speech.items.length && generation === speech.generation) {
        await new Promise((resolve) => setTimeout(resolve, SENTENCE_GAP_MS));
      }
    }
  } finally {
    speech.draining = false;
    announceSpeaking(false);
    // Clear the subtitle here rather than at the end of the loop: this also runs
    // when he is interrupted, which is exactly when a line left on screen would
    // be claiming he is still saying something he has stopped saying.
    face.setSpeech?.(null);
  }
}

function playClip(blob) {
  const url = URL.createObjectURL(blob);
  // Marks the start of the whole run of speech, not this one sentence — the
  // runaway guard below asks "did he barely get going before being cut off?",
  // which would be true of every clip if this reset on each one.
  if (mode !== "speaking") speakingSince = Date.now();
  setMode("speaking");

  // Keep capturing while he talks so you can cut him off. The utterance itself
  // is still ignored unless barge-in fires — handleUtterance won't act while the
  // mode is "speaking".
  if (bargeInReady()) localListener.enable();

  return new Promise((resolve) => {
    // Held so an interruption can cut the sentence short without hanging here.
    endSpeech = resolve;
    player.onended = resolve;
    player.onerror = resolve;
    player.src = url;
    player.play().catch(resolve);
  }).then(() => {
    endSpeech = null;
    URL.revokeObjectURL(url);
  });
}

function browserSpeak(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    const utterance = new SpeechSynthesisUtterance(text);
    const preferred = speechSynthesis
      .getVoices()
      .find((v) => /Google UK English Male|Ryan|Guy|Daniel/i.test(v.name));
    if (preferred) utterance.voice = preferred;
    utterance.rate = 1.02;
    utterance.onend = resolve;
    utterance.onerror = resolve;
    setMode("speaking");
    speechSynthesis.speak(utterance);
  });
}

function stopSpeaking() {
  // Bumping the generation abandons everything queued and everything still being
  // synthesized; the drain loop checks it and bails out.
  speech.generation++;
  const abandoned = speech.items;
  speech.items = [];
  for (const item of abandoned) item.done();

  player.pause();
  player.currentTime = 0;
  window.speechSynthesis?.cancel();
  // Pausing never fires "ended", so release the waiting promise ourselves.
  endSpeech?.();
  endSpeech = null;
}

// ---------------------------------------------------------------------------
// Audio analysis — drives the face
// ---------------------------------------------------------------------------

/**
 * Push the current setting into the live effect.
 *
 * Called whenever the setting changes AND once when the graph is built, because
 * the dialog can be applied before he has ever spoken — at which point there is
 * no audio context yet and nothing to push it into.
 */
function applyVocoder() {
  vocoder?.apply(vocoderSettings.enabled, vocoderSettings.amount);
}

/**
 * Push the volume into the live graph.
 *
 * Ramped rather than set, for the same reason the vocoder's gains are: moving
 * the knob while he is mid-sentence would otherwise click. 15 ms is short enough
 * to feel instant and long enough to be silent.
 */
function applyVolume() {
  if (!voiceGain || !audioCtx) return;
  voiceGain.gain.setTargetAtTime(volume, audioCtx.currentTime, 0.015);
}

/**
 * The audio context and the volume bus, and nothing else.
 *
 * Split out of setupAudio() because the set now makes noises while it is
 * warming up, and the boot sequence starts BEFORE the microphone is opened —
 * deliberately, so the four seconds are spent on work that was happening
 * anyway. Without this the degauss thunk would land on a context that does not
 * exist yet, which is to say it would land nowhere.
 *
 * Safe to call more than once, and called from inside the Wake click, so the
 * context is unlocked by a real user gesture rather than by autoplay.
 */
function primeAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume().catch(() => {});
  }
  if (!voiceGain) {
    voiceGain = audioCtx.createGain();
    voiceGain.gain.value = volume;
    voiceGain.connect(audioCtx.destination);
  }
  return audioCtx;
}

async function setupAudio() {
  primeAudio();
  await audioCtx.resume();

  // Greg's own voice, so the face moves in time with what he says.
  voiceAnalyser = audioCtx.createAnalyser();
  voiceAnalyser.fftSize = 256;
  voiceAnalyser.smoothingTimeConstant = 0.72;
  // The effect goes BEFORE the analyser, so the face reacts to what you can
  // actually hear rather than to the clean signal underneath it. If it fails to
  // build, the source connects straight through and he simply sounds normal.
  const source = audioCtx.createMediaElementSource(player);
  vocoder = createVocoder(audioCtx);
  if (vocoder) {
    source.connect(vocoder.input);
    vocoder.output.connect(voiceAnalyser);
  } else {
    source.connect(voiceAnalyser);
  }
  // The volume bus is already built — see primeAudio(). Everything he makes a
  // sound with goes through it: the speech, the announcement chime and the
  // warm-up noises, which is why it is a bus rather than a property on the
  // player element.
  //
  // The analyser feeds it, and that order is the one placement decision worth
  // arguing about. The vocoder sits before the analyser so the face reacts to
  // what you can hear; the volume sits after it so the face keeps moving when
  // you turn him down. Turning the sound off on a television does not stop the
  // picture, and a face that went slack at low volume would read as him having
  // stopped talking rather than as you having stopped listening.
  voiceAnalyser.connect(voiceGain);
  applyVocoder();
  spectrum = new Uint8Array(voiceAnalyser.frequencyBinCount);

  // Your voice, so the face reacts while you're talking.
  try {
    micStream = await openMicrophone(micDeviceId);
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 512;
    micAnalyser.smoothingTimeConstant = 0.8;
    audioCtx.createMediaStreamSource(micStream).connect(micAnalyser);
  } catch (err) {
    micAnalyser = null; // face still animates, just not from your voice
    micStream = null;
    // Keep WHY. This used to be swallowed entirely, so a machine with no
    // microphone, a blocked permission or a device held by another program all
    // produced the same thing: a page that looks perfectly healthy, says "Say
    // Hey Greg", and never hears anything. The offline ears then fail for a
    // second reason — no stream to read — and the browser fallback fails for a
    // third, so by the time anything is reported the original cause is three
    // steps back. Naming it here is the difference between a five-minute fix
    // and an evening.
    micError = err;
    console.warn(`[mic] getUserMedia failed: ${err.name} — ${err.message}`);
  }

  pumpAnalysis();
}

// ---------------------------------------------------------------------------
// Microphone diagnostics — http://localhost:4747/?mic
//
// "He can't hear me" has at least five causes that are indistinguishable from
// the outside: Chrome opened a different input device from the one Windows is
// showing you, the track is muted at the OS level, capture is switched off, the
// signal never clears the noise floor, or Whisper hears it and returns something
// the wake matcher rejects. Guessing between them costs a round trip through the
// user every time. This shows all five at once.
//
// Off unless asked for, so it costs nothing in normal use.
// ---------------------------------------------------------------------------

const micDebug = new URLSearchParams(location.search).has("mic");
let lastHeard = null;
let lastHeardAt = 0;
let micDebugTimer = null;

function startMicDebug() {
  if (!micDebug || micDebugTimer) return;
  el.hint.style.fontFamily = '"Consolas", "Lucida Console", monospace';
  el.hint.style.whiteSpace = "normal";

  micDebugTimer = setInterval(() => {
    const track = micStream?.getAudioTracks?.()[0] ?? null;
    const l = localListener;

    // A bar, because a number changing ten times a second is unreadable and the
    // question is only ever "does this move when I speak".
    const level = l ? l.lastRms : 0;
    const filled = Math.min(20, Math.round((level / 0.08) * 20));
    const bar = "#".repeat(filled) + "-".repeat(20 - filled);
    const over = l && l.threshold > 0 && level > l.threshold;

    const heard = lastHeard
      ? `"${lastHeard}" ${Math.round((Date.now() - lastHeardAt) / 1000)}s ago`
      : "nothing yet";

    el.hint.textContent = [
      `device: ${track ? track.label || "(unnamed)" : "NO TRACK"}`,
      track ? `muted=${track.muted} live=${track.readyState === "live"}` : null,
      l ? `[${bar}] ${level.toFixed(4)}${over ? " OVER" : ""}` : "no offline listener (browser recognition)",
      l ? `floor ${l.noiseFloor.toFixed(4)} trigger ${l.threshold.toFixed(4)}` : null,
      l ? (l.enabled ? (l.speaking ? "SPEAKING" : "armed") : "capture OFF") : null,
      `mode ${mode}`,
      `whisper: ${heard}`,
    ]
      .filter(Boolean)
      .join("  |  ");
  }, 150);
}

// ---------------------------------------------------------------------------
// Which microphone
//
// Chrome pins a device per site, so the one it opens is whatever was default
// when permission was first granted — which may since have been unplugged. The
// failure mode that matters is NOT an error: a stream can open successfully and
// deliver pure silence, which looks like a broken microphone, a broken Whisper,
// or a broken wake word depending on where you happen to be looking.
// ---------------------------------------------------------------------------

const AUDIO_TUNING = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

/**
 * Open a microphone, preferring `deviceId` but never insisting on it.
 *
 * `exact` is what makes the preference meaningful — without it Chrome treats a
 * missing device as a hint and quietly opens something else. But insisting on a
 * device that has been unplugged fails outright, so the whole point of the
 * fallback is that changing your headphones can never leave Greg with no
 * microphone at all.
 */
async function openMicrophone(deviceId) {
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, ...AUDIO_TUNING },
      });
    } catch (err) {
      console.warn(`[mic] saved microphone unavailable (${err.name}) — falling back to the system default`);
      micFellBack = true;
    }
  }
  return await navigator.mediaDevices.getUserMedia({ audio: AUDIO_TUNING });
}

/** Every input Chrome will admit to, for the Settings picker. */
async function listMicrophones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "audioinput")
      // Labels are empty until permission has been granted at least once, which
      // is why the picker is only useful after waking him.
      .map((d) => ({ id: d.deviceId, label: d.label || "(unnamed input)" }));
  } catch {
    return [];
  }
}

/**
 * Switch microphone without reloading.
 *
 * Everything downstream is wired to the stream, not to the device, so the whole
 * chain has to be rebuilt: the analyser that drives the face, and the listener
 * that holds the ring buffer and the noise floor.
 */
async function switchMicrophone(deviceId) {
  if (!audioCtx) return { error: "wake Greg first — the microphone isn't running yet" };

  try {
    const stream = await openMicrophone(deviceId);

    localListener?.stop();
    localListener = null;
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = stream;
    micError = null;

    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 512;
    micAnalyser.smoothingTimeConstant = 0.8;
    audioCtx.createMediaStreamSource(micStream).connect(micAnalyser);

    if (config.listening === undefined) config.listening = {};
    if (await startLocalListening()) startListening();

    const label = micStream.getAudioTracks()[0]?.label ?? "the new device";
    console.log(`[mic] switched to ${label}`);
    return { ok: true, label };
  } catch (err) {
    return { error: micProblem(err) ?? err.message };
  }
}

/**
 * Plain English for why the microphone didn't open.
 *
 * The wording now depends on the window. Greg is opened with Chrome's `--app=`,
 * which has no address bar, and the blocked message used to say "click the
 * padlock in the address bar" — advice that cannot be followed in the only
 * window most people ever see him in. See public/mic-help.js.
 */
function micProblem(err) {
  return micProblemFor(err, {
    hasAddressBar: hasAddressBar(window),
    origin: location.origin,
  });
}

function pumpAnalysis() {
  const micData = micAnalyser ? new Uint8Array(micAnalyser.fftSize) : null;

  const tick = () => {
    if (mode === "speaking" && voiceAnalyser) {
      voiceAnalyser.getByteFrequencyData(spectrum);
      face.setSpectrum(spectrum);
      let sum = 0;
      for (let i = 0; i < spectrum.length; i++) sum += spectrum[i];
      face.setLevel(sum / spectrum.length / 128);
    } else if (micAnalyser && (mode === "idle" || mode === "armed")) {
      face.setSpectrum(null);
      micAnalyser.getByteTimeDomainData(micData);
      let sum = 0;
      for (let i = 0; i < micData.length; i++) {
        const v = (micData[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / micData.length);
      face.setLevel(Math.min(1, rms * 6));
    } else {
      face.setSpectrum(null);
      face.setLevel(0.12);
    }
    requestAnimationFrame(tick);
  };

  tick();
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function updateMicButton() {
  el.micBtn.classList.toggle("off", !micEnabled);
  el.micBtn.title = micEnabled ? "Mute microphone" : "Unmute microphone";
  el.micBtn.textContent = micEnabled ? "🎙" : "🔇";
}

el.micBtn.addEventListener("click", () => {
  micEnabled = !micEnabled;
  wantListening = micEnabled;
  micEnabled ? startListening() : stopListening();
  updateMicButton();
  if (mode === "idle" || mode === "armed") setMode("idle");
});

// A second window rather than a mode: his face stays visible, and he keeps
// talking while you spin the globe. Named, so clicking again focuses the window
// you already have instead of opening another.
el.globeBtn?.addEventListener("click", () => {
  const globe = window.open("/globe.html", "greg-globe", "width=880,height=720");
  globe?.focus();
});

// ---------------------------------------------------------------------------
// Music: bob to whatever is coming out of the speakers
//
// Not Spotify. Spotify's audio never reaches the browser, and its beat-analysis
// endpoints are deprecated for new apps — so the only way to be genuinely on the
// beat is to listen to the machine's own output. That also means he dances to
// anything: Spotify, YouTube, a game.
//
// getDisplayMedia needs a click and a "share audio" tick every page load. That is
// a browser security rule, not something that can be engineered around, so it
// gets a button rather than happening quietly at startup.
// ---------------------------------------------------------------------------

let musicStream = null;
let musicAnalyser = null;
let musicRaf = 0;

async function startMusicVisualiser() {
  if (musicStream) return stopMusicVisualiser();

  try {
    // Video is requested because Chrome will not offer system audio without it —
    // the video track is discarded immediately below.
    musicStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    el.hint.textContent = "No audio shared — Greg needs the “share system audio” tick to see the music.";
    return;
  }

  // The shared AudioContext is only created when Greg is woken for the
  // microphone, and the music button can be clicked before that — so make one if
  // it isn't there yet rather than throwing on a null.
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});

  const audio = musicStream.getAudioTracks();
  if (!audio.length) {
    // Picking a window instead of a screen, or forgetting the tick, lands here.
    stopMusicVisualiser();
    el.hint.textContent = "That share had no audio in it — pick a screen or tab and tick “share system audio”.";
    return;
  }
  // The picture is never wanted; keeping it alive would light the sharing
  // indicator for no reason and cost a capture pipeline.
  for (const track of musicStream.getVideoTracks()) track.stop();

  const source = audioCtx.createMediaStreamSource(new MediaStream(audio));
  musicAnalyser = audioCtx.createAnalyser();
  // 2048 rather than 512: at 48 kHz that is 23 Hz per bin instead of 94, which is
  // the difference between being able to isolate a kick drum and not. The old
  // size made the lowest usable slice 0-2.8 kHz — snares, vocals and guitars all
  // inside "bass", so every onset in the mix registered as a beat and he nodded
  // continuously.
  musicAnalyser.fftSize = 2048;
  // Low, deliberately. Smoothing averages the spectrum across frames, which is
  // fine for bars but destroys the transient a beat detector runs on — at 0.72
  // a kick drum arrived as a gentle swell and never cleared the threshold, so
  // the head sat perfectly still. The renderer smooths the bars itself, so there
  // is nothing to lose here.
  musicAnalyser.smoothingTimeConstant = 0.2;
  source.connect(musicAnalyser);
  // Deliberately not connected to the destination: that would play the captured
  // audio back through the speakers on top of itself.

  const bins = new Uint8Array(musicAnalyser.frequencyBinCount);
  const pump = () => {
    musicRaf = requestAnimationFrame(pump);
    musicAnalyser.getByteFrequencyData(bins);

    // Bins 1..6 only — roughly 25 to 165 Hz, which is where a kick drum's
    // fundamental lives. Bin 0 is skipped: it holds DC and subsonic rumble and
    // carries no rhythm.
    //
    // Computed from the sample rate rather than hardcoded, because a 44.1 kHz
    // device would put these bins somewhere else entirely.
    const hzPerBin = audioCtx.sampleRate / musicAnalyser.fftSize;
    const lowBin = Math.max(1, Math.round(25 / hzPerBin));
    const highBin = Math.max(lowBin + 1, Math.round(165 / hzPerBin));
    let bass = 0;
    for (let i = lowBin; i <= highBin; i++) bass += bins[i];
    bass = bass / (highBin - lowBin + 1) / 255;

    // Overall loudness drives the bar colour. Only the lower 60% of the spectrum:
    // the top bins are near-silent on almost all music, and averaging them in
    // dragged the figure down to around 0.15 even on loud tracks, so the colour
    // barely moved. The curve then lifts ordinary listening levels into a range
    // that actually shows.
    let level = 0;
    const useful = Math.floor(bins.length * 0.6);
    for (let i = 0; i < useful; i++) level += bins[i];
    level = Math.pow(level / useful / 255, 0.65);

    face.setMusic?.({ spectrum: bins, bass, level });
  };
  pump();

  // Stopping the share from Chrome's own bar has to switch him off too.
  audio[0].addEventListener("ended", () => stopMusicVisualiser());

  el.musicBtn?.classList.add("btn-on");
  el.hint.textContent = "Listening to your speakers — Greg will move to whatever is playing.";
}

function stopMusicVisualiser() {
  cancelAnimationFrame(musicRaf);
  musicRaf = 0;
  musicStream?.getTracks().forEach((track) => track.stop());
  musicStream = null;
  musicAnalyser = null;
  face.setMusic?.(null);
  el.musicBtn?.classList.remove("btn-on");
}

el.musicBtn?.addEventListener("click", () => startMusicVisualiser());

// ---------------------------------------------------------------------------
// Channels
//
// Greg is a television, and his face has programmes on it. The current channel
// lives on the server in lib/channels.js — voice sets it, the knob on the
// cabinet sets it, and this paints whatever the server last said. The page never
// keeps its own idea of what is showing, for the same reason gaming mode is
// derived rather than stored: two sources of truth for one fact is one too many.
// ---------------------------------------------------------------------------

let channel = null;
let nowPlayingTimer = null;
let hadReading = false;
let feedTimer = null;
let feedId = null;

// How often to ask what is playing while that channel is up. The reading carries
// a timestamp and the face interpolates the progress bar between them, so this
// only has to be often enough to catch a track CHANGING, not to animate.
const NOW_PLAYING_MS = 2500;

function paintChannel(state) {
  channel = state;
  // The channel's own entry goes through too, which is how the face learns a
  // channel is one somebody added: it has no renderer in the static map and has
  // to fetch one, or be drawn from its `display` block.
  face.setChannel?.(
    state.channel,
    state.id,
    state.channels?.length,
    state.channels?.find((c) => c.id === state.id) ?? null,
  );

  if (el.channelBtn) {
    el.channelBtn.classList.toggle("btn-on", state.channel !== 1);
    el.channelBtn.title = `Showing channel ${state.channel} — ${state.name}. Click for the next one, shift-click to go back.`;
  }

  // Polling is what keeps the media watcher alive on the server; it shuts itself
  // down a minute after the last request. So switching away from the channel is
  // also what releases the PowerShell process, with nothing needing to say so.
  // Guarded on the renderer, not just the channel: a face that can't show a
  // programme shouldn't keep a PowerShell watcher alive on the other side to
  // feed it readings nobody draws.
  const wantPolling = state.id === "nowplaying" && typeof face.setNowPlaying === "function";
  if (wantPolling && !nowPlayingTimer) {
    hadReading = false;
    pollNowPlaying();
    nowPlayingTimer = setInterval(pollNowPlaying, NOW_PLAYING_MS);
  } else if (!wantPolling && nowPlayingTimer) {
    clearInterval(nowPlayingTimer);
    nowPlayingTimer = null;
    face.setNowPlaying?.(null);
  }

  startFeed(state);
}

/**
 * Poll whatever data the channel showing needs, if it needs any.
 *
 * `state.feed` comes from lib/channels.js and names an entry in
 * lib/programmes.js. A channel with no feed — the test card — is simply never
 * polled for, and nothing here has to know which channels those are.
 *
 * The INTERVAL comes from the server too, in the reply. NASA's keyless demo key
 * allows fifty requests a day across everything sharing this address, and a
 * limit like that has to be enforced where it is understood rather than guessed
 * at in the browser. So the first reply sets the timer for the rest.
 */
function startFeed(state) {
  const wanted = typeof face.setProgramme === "function" ? state.feed ?? null : null;
  if (wanted === feedId) return;

  clearTimeout(feedTimer);
  feedTimer = null;
  feedId = wanted;
  face.setProgramme?.(null, null);

  if (!wanted) return;
  pollFeed(wanted);
}

async function pollFeed(id) {
  // A channel change between the request going out and the reply coming back
  // would otherwise paint the old programme over the new one.
  if (feedId !== id) return;
  if (offline) {
    scheduleFeed(id, 5000);
    return;
  }

  let data = null;
  try {
    const res = await fetch(`/api/programme?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    data = await res.json();
  } catch {
    // Greg going away is the heartbeat's business, not this poll's.
  }

  if (feedId !== id) return;
  if (data) face.setProgramme?.(id, data);
  scheduleFeed(id, data?.pollMs);
}

/** Ask again now, whatever the timer says. Used when something has changed. */
function refreshFeed() {
  if (!feedId) return;
  clearTimeout(feedTimer);
  feedTimer = null;
  pollFeed(feedId);
}

function scheduleFeed(id, pollMs) {
  clearTimeout(feedTimer);
  // setTimeout rather than setInterval, and re-armed by the reply: a source that
  // has gone slow must not have a queue of requests pile up behind it.
  feedTimer = setTimeout(() => pollFeed(id), Math.max(5000, Number(pollMs) || 60000));
}

async function pollNowPlaying() {
  if (offline) return;
  try {
    // The first ask after a cold start has to wait for PowerShell to come up,
    // or the channel shows "nothing playing" for a couple of seconds before
    // correcting itself — which reads as a bug rather than as a wait.
    const wait = hadReading ? "" : "?wait=4000";
    const res = await fetch(`/api/nowplaying${wait}`, { cache: "no-store" });
    if (!res.ok) return;
    const reading = await res.json();
    if (!reading.pending) hadReading = true;
    face.setNowPlaying?.(reading);
  } catch {
    // Greg going away is the heartbeat's business, not this poll's.
  }
}

/**
 * Turn the dial. `step` is +1 forward, -1 back.
 *
 * The server wraps in both directions, so there is no end of the dial to reach
 * — channel 1 back one is the last channel, which is what a knob does.
 */
async function turnChannelKnob(step = 1) {
  try {
    const res = await fetch("/api/channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step }),
    });
    if (res.ok) paintChannel(await res.json());
  } catch {
    el.hint.textContent = "couldn't reach Greg to change the channel";
  }
}

/**
 * Turn the volume knob. `step` is +1 louder, -1 quieter.
 *
 * Applied to the live graph FIRST and saved afterwards. The sound has to change
 * on the click, not on the round trip — and if the save fails he stays at the
 * volume you just set rather than jumping back to the old one, which is the
 * behaviour of a knob. The server broadcast repaints every window.
 *
 * Unlike the channel, this does not wrap: see stepVolume() in volume.js.
 */
async function turnVolumeKnob(step = 1) {
  setVolume(stepVolume(volume, step));

  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volume }),
    });
    if (!res.ok) throw new Error("rejected");
  } catch {
    // Not fatal, and deliberately not spoken: he is quieter, it simply will not
    // be quieter after a restart. Saying so out loud at the moment somebody has
    // asked for less noise would be its own joke.
    console.warn("[volume] couldn't save the new level");
  }
}

/** Take a volume on, everywhere it has to be true at once. */
function setVolume(next, { show = true } = {}) {
  volume = clampVolume(next);
  applyVolume();
  // The cabinet's own knob and the readout over the picture. Optional, like
  // every capability beyond the four methods a face must have — a renderer with
  // no knobs simply never hears about it.
  face.setVolume?.(volume, { show });
  if (el.volumeBtn) {
    el.volumeBtn.classList.toggle("btn-off", volume <= 0);
    el.volumeBtn.title = `Volume ${volumeLabel(volume)}. Click to turn him up, shift-click to turn him down — or use the left knob on the set.`;
  }
}

// Shift-click goes down, the way it goes back on the channel button. The knob on
// the cabinet is the discoverable version — left half quieter, right half louder.
el.volumeBtn?.addEventListener("click", (event) => turnVolumeKnob(event.shiftKey ? -1 : 1));

// Shift-click goes back. The knob on the cabinet is the discoverable way to do
// it — its left half turns back, its right half forward — and this is the same
// thing for anyone using the buttons. The tooltip in paintChannel() says so.
el.channelBtn?.addEventListener("click", (event) => turnChannelKnob(event.shiftKey ? -1 : 1));

fetch("/api/channel")
  .then((r) => r.json())
  .then(paintChannel)
  .catch(() => {});

// ---------------------------------------------------------------------------
// Settings
//
// The dialog itself is in settings.js and holds nothing; the server owns the
// values. This is the half only the page can do: several of those settings are
// enforced in the browser — the wake matcher, the follow-up timer, the barge-in
// sustain and the microphone thresholds — so they have to be taken on by the
// objects already running, not just stored.
//
// Without this the settings would be saved correctly, survive a restart, and
// appear to do nothing until you reloaded, which is the most confusing possible
// way for them to be right.
// ---------------------------------------------------------------------------

function adoptSettings(state) {
  if (!state) return;

  config.name = state.name ?? config.name;
  if (state.wakeWords?.length) config.wakeWords = state.wakeWords;

  // Same pattern as the microphone levels below: remembered here so a graph
  // built later starts with the right values, and pushed into the live effect
  // when there is one, so a change applies to the next thing he says rather
  // than the next time he starts.
  if (state.appearance?.background) {
    document.documentElement.style.setProperty("--desktop", state.appearance.background);
  }

  // Shown only when it actually MOVED, and never on the first adoption.
  //
  // Without the first test the readout flashes up over the picture every time
  // any unrelated setting is applied. Without the second it flashes at startup,
  // because taking on the saved value is itself a change from the 1 the page
  // starts at — an on-screen display is feedback for something that just
  // happened, and one that greets you reads as a fault. A change made in
  // ANOTHER window does show, which is right: it is the only thing that would
  // explain why he suddenly got quieter.
  if (state.volume !== undefined) {
    const next = clampVolume(state.volume);
    setVolume(next, { show: volumeAdopted && next !== volume });
    volumeAdopted = true;
  }

  // Only the mode is pushed. Whether the words are actually up is decided by the
  // face, which already holds the volume — asking here would put one fact in two
  // places, and the two would disagree the first time the knob moved.
  if (state.subtitles !== undefined) face.setSubtitleMode?.(state.subtitles);

  if (state.vocoder) {
    vocoderSettings = {
      enabled: state.vocoder.enabled === true,
      amount: Number(state.vocoder.amount) || 0,
    };
    applyVocoder();
  }
  if (state.listening) {
    if (typeof state.listening.deviceId === "string") micDeviceId = state.listening.deviceId;
    config.followUp = { enabled: state.listening.followUpEnabled, seconds: state.listening.followUpSeconds };
    config.bargeIn = { enabled: state.listening.bargeInEnabled, sustainMs: state.listening.bargeInSustainMs };

    // Remembered FIRST, so a listener built later in wake() starts with the
    // right numbers — adoptSettings runs before the listener exists, and the
    // push below is skipped on that pass. Storing them is what makes the
    // setting survive a restart at all.
    if (Number(state.listening.floorMultiple) > 0) micLevels.floorMultiple = Number(state.listening.floorMultiple);
    if (Number(state.listening.minLevel) > 0) micLevels.minLevel = Number(state.listening.minLevel);

    // And pushed into the live instance when there is one, because it only
    // takes them from the constructor and a change made in the dialog should
    // apply to the next thing you say, not the next time Greg starts.
    if (localListener) {
      localListener.floorMultiple = micLevels.floorMultiple;
      localListener.minLevel = micLevels.minLevel;
    }

    // Turning barge-in back on in the dialog should clear the runaway guard that
    // switched it off, or the setting would be quietly overruled by a decision
    // made before the user changed their mind.
    if (state.listening.bargeInEnabled && bargeInDisabled) {
      bargeInDisabled = false;
      earlyBargeIns = 0;
    }
  }

  // The status line names him, so a rename has to be visible immediately rather
  // than at the next mode change.
  if (mode === "idle" || mode === "off") setMode(mode);
}

initSettings({
  onApply: adoptSettings,
  listMicrophones,
  switchMicrophone,
  // The dialog's level meter reads the same numbers the ?mic readout does, so
  // the mic trigger can be set against a real voice instead of guessed at.
  micReader: () =>
    localListener
      ? { level: localListener.lastRms, floor: localListener.noiseFloor, threshold: localListener.threshold }
      : null,
  // Heard as the slider moves, not on Apply. A volume you have to commit to
  // before hearing is a worse control than the knob it duplicates. Cancel undoes
  // it by construction: closing the dialog repaints from the last server state,
  // which comes back through adoptSettings.
  volumePreview: (next) => setVolume(next),
});

// ---------------------------------------------------------------------------
// Power: eyes and gaming mode
//
// Both switches live on the server in lib/power.js, and both the buttons and the
// voice tools go through it. The face never keeps its own copy of the state — it
// paints whatever the server last said, so the two cannot drift apart.
// ---------------------------------------------------------------------------

let power = null;

function paintPower(state) {
  power = state;
  if (!el.eyesBtn || !el.gamingBtn) return;

  const eyes = state.vision ?? {};
  // A model that failed its eyesight test has no eyes to switch on. Disable the
  // control and say why, rather than offering a button that can only fail.
  el.eyesBtn.disabled = !eyes.proven;
  el.eyesBtn.classList.toggle("btn-on", Boolean(eyes.active));
  el.eyesBtn.textContent = eyes.active ? "👁" : "🚫";
  el.eyesBtn.title = !eyes.proven
    ? `Greg can't see — ${eyes.reason || "the eyesight test failed"}`
    : eyes.active
      ? "Close Greg's eyes (frees ~5.9 GB)"
      : "Open Greg's eyes";

  const voice = state.clonedVoice ?? {};
  el.gamingBtn.classList.toggle("btn-on", Boolean(state.gamingMode));
  el.gamingBtn.title = state.gamingMode
    ? voice.starting
      ? "Gaming mode on — cloned voice still loading"
      : "Gaming mode ON — tap to restore eyes and the cloned voice"
    : "Gaming mode — free up the graphics card";
}

async function switchPower(what, on) {
  try {
    const res = await fetch("/api/power", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ what, on }),
    });
    const data = await res.json();
    if (!res.ok) {
      el.hint.textContent = data.error ?? "that switch wouldn't move";
      return;
    }
    paintPower(data);
    if (what === "gamingMode") {
      el.hint.textContent = on
        ? "Gaming mode on — eyes closed, voice back to the built-in one, about 10 GB freed."
        : "Gaming mode off — cloned voice loading, about 45 seconds.";
    } else {
      el.hint.textContent = on ? "Eyes open." : "Eyes closed — about 5.9 GB freed.";
    }
  } catch {
    el.hint.textContent = "couldn't reach Greg to change that";
  }
}

el.eyesBtn?.addEventListener("click", () => switchPower("vision", !power?.vision?.active));
el.gamingBtn?.addEventListener("click", () => switchPower("gamingMode", !power?.gamingMode));

// Paint the real state on load rather than assuming: a reload mid-game must not
// show eyes open when they are off.
fetch("/api/power")
  .then((r) => r.json())
  .then(paintPower)
  .catch(() => {});

el.resetBtn.addEventListener("click", async () => {
  await fetch("/api/reset", { method: "POST" });
  showYou("");
  showGreg("");
  el.status.textContent = "Fresh start.";
  setTimeout(() => setMode(mode), 1200);
});

el.input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const text = el.input.value.trim();
  if (!text || offline || mode === "thinking" || mode === "speaking") return;
  el.input.value = "";
  ask(text);
});

// Click the face to interrupt, or to talk without saying the wake word.
el.canvas.addEventListener("click", (event) => {
  if (offline) return;

  // Before anything else: a click during the boot sequence skips it. Four
  // seconds of warm-up is an event the first time and an obstacle the twentieth,
  // and during development the page gets reloaded constantly. This must come
  // before the knob test — while the set is booting there is no channel to turn.
  if (face.skipBoot?.()) return;

  // The knob first. Turning the channel must not also cut him off mid-sentence —
  // they are the same click on the same canvas, and everything below treats a
  // click as "stop talking to me".
  // Which SIDE of the knob was clicked decides the direction — left turns back,
  // right turns forward, the way a dial does.
  const hit = face.hitTest?.(event.clientX, event.clientY);
  if (hit === "channel-up" || hit === "channel-down") {
    turnChannelKnob(hit === "channel-down" ? -1 : 1);
    return;
  }
  // The left knob is the volume, and it matters that this returns before the
  // barge-in below: turning him down while he is talking is the single most
  // likely moment to reach for it, and having that also cut him off would make
  // the control unusable for the one job it exists for.
  if (hit === "volume-up" || hit === "volume-down") {
    turnVolumeKnob(hit === "volume-down" ? -1 : 1);
    return;
  }

  if (mode === "speaking" || mode === "thinking") {
    abandonAnswer();
    setMode("idle");
    if (micEnabled) startListening();
    return;
  }
  if (mode === "idle" && micEnabled) arm();
});

// Closing or hiding the window must also release the microphone and cut any
// speech — otherwise a backgrounded tab carries on listening and talking.
window.addEventListener("pagehide", () => {
  wantListening = false;
  clearInterval(heartbeatTimer);
  clearInterval(reconnectTimer);
  events?.close();
  stopListening();
  abandonAnswer();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Should the set warm up, or just come on?
 *
 * Off for anyone who has asked the operating system for less animation — a
 * four-second bloom is exactly what that setting is about — and off with
 * `?boot=0`, which is the switch to reach for when you are reloading the page
 * every thirty seconds. Deliberately not in the Settings dialog: it would only
 * take effect on the next wake, and a control that appears to do nothing when
 * you press it is worse than no control at all.
 */
/** The Win98 title bar. Missing in a stripped-down page, so never assumed. */
function setTitle(text) {
  const el = document.querySelector(".title-text");
  if (el) el.textContent = text;
}

function bootWanted() {
  if (new URLSearchParams(location.search).get("boot") === "0") return false;
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

async function wake() {
  el.overlay.classList.add("gone");

  try {
    config = await (await fetch("/api/config")).json();
    face.setUptimeStart?.(config.startedAt);
  } catch {
    /* keep defaults */
  }

  el.badge.textContent = config.hasBrain ? `${config.location?.city ?? ""}`.trim() || "online" : "basic mode";
  el.badge.title = config.brainLabel ?? "";
  el.badge.classList.toggle("warn", !config.hasBrain);

  // The set warms up while the microphone, the worklet and the settings are
  // still being fetched below — so most of these four seconds are spent on work
  // that was happening anyway. Started here rather than at the top of wake()
  // because the POST screen lists what actually loaded, and that is what the
  // fetch above just went and got.
  // Guarded: everything from here to startListening() is load-bearing for the
  // microphone, and a throw in wake() costs the user their ears for a warm-up
  // animation. Same reasoning as createFace() never being allowed to throw.
  // Started WITHOUT waiting for anything, and that is deliberate — it was
  // briefly not, and the warm-up stopped appearing.
  //
  // The settings fetch below is needed before the microphone opens (it names the
  // device) and before the first noise (it holds the volume), so it is tempting
  // to await it here. Don't. Putting a network round trip and a second failure
  // point in front of the picture cost the boot sequence outright: nothing at
  // all is a far worse outcome than a warm-up that starts a few milliseconds
  // early, and the muted-startup problem it was solving has a cheaper answer —
  // `bootSound` waits for `settingsReady` before making a sound, so the PICTURE
  // never waits and the SOUND always knows the volume.
  settingsReady = (async () => {
    try {
      const saved = await (await fetch("/api/settings", { cache: "no-store" })).json();
      adoptSettings(saved);
    } catch {
      /* defaults are fine */
    }
  })();

  const wantBoot = bootWanted();
  let booting = Promise.resolve();
  try {
    if (wantBoot) {
      booting = face.playBoot?.(config, { onBeat: bootSound }) ?? Promise.resolve();
      if (!face.playBoot) console.warn("[boot] this renderer has no warm-up — falling back to the plain face");
      setTitle(`${config.name} — starting…`);
    } else {
      // Said out loud, because "the warm-up did not appear" has several causes
      // that look identical from the outside and none of them announce
      // themselves: ?boot=0 in the URL, the operating system asking for less
      // animation, or a click landing on the face and skipping it. Finding out
      // which cost a round trip through the user once.
      console.info("[boot] warm-up off — ?boot=0 or prefers-reduced-motion");
    }
  } catch (err) {
    console.warn("[boot] skipped:", err.message);
  }

  await settingsReady;
  await setupAudio();

  // Prefer the local, offline ears when the server has them running.
  const wantsLocal = config.listening === "local";
  const localReady = wantsLocal ? await startLocalListening() : false;

  // The microphone itself, before anything that depends on it. Both listening
  // routes below need it — the offline ears read the stream directly, and
  // browser recognition opens the same device for itself — so if it never
  // opened, neither of them can work and saying which one we picked would be
  // describing a choice that doesn't matter.
  const problem = micProblem(micError);
  if (problem) {
    micEnabled = false;
    wantListening = false;
    el.hint.textContent = problem;
    el.badge.textContent = "no microphone";
    el.badge.classList.add("warn");
    // The status line is not set here: setMode("idle") below owns it, and with
    // micEnabled false it already reads "Microphone off — type below".
  } else if (localReady) {
    wantListening = true;
    startListening();
    el.hint.textContent = `Say “Hey ${config.name}” — listening offline on this machine.`;
  } else if (SpeechRecognition) {
    recognition = buildRecognition();
    wantListening = true;
    startListening();
    if (wantsLocal) el.hint.textContent = "Offline ears didn't start — using browser speech recognition.";
  } else {
    micEnabled = false;
    el.hint.textContent = "Speech recognition needs Chrome or Edge — you can still type below.";
  }
  updateMicButton();
  startHeartbeat();
  connectEventStream();
  // Last, so it owns the hint line rather than being overwritten by whichever
  // listening path was chosen above.
  startMicDebug();

  // ?nod opens the nod tuning panel, the same way ?mic opens the microphone
  // readout — off unless asked for, and loaded on demand so it costs nothing to
  // anyone who never asks. Guarded because a broken panel must not cost the
  // microphone: everything in wake() from here on is load-bearing.
  if (new URLSearchParams(location.search).has("nod")) {
    import("./nod-panel.js")
      .then((m) => m.initNodPanel(face))
      .catch((err) => console.warn("[nod] panel failed to load:", err.message));
  }

  // The boot greeting takes several seconds, and handleUtterance() drops
  // anything heard while the mode is "speaking" — so for the whole of it the
  // page was promising "Say Hey Greg" while being completely deaf. That is the
  // "he ignored me at first and then suddenly started working mid-test" report:
  // nothing was broken, he was busy introducing himself, and the hint line was
  // lying about it. Say what is actually true and the confusion goes away.
  const readyHint = el.hint.textContent;
  if (!micDebug && micEnabled) {
    // Covers the warm-up as well as the greeting now. The hint has to describe
    // the WHOLE window in which handleUtterance() drops what it hears, and the
    // boot sequence lengthened that window by about four seconds — exactly the
    // trap CLAUDE.md warns about for anything added before he speaks.
    el.hint.textContent = `${config.name} is warming up — he can't hear you until he has finished.`;
  }

  // Load the model behind the warm-up.
  //
  // The boot sequence and the greeting take about seven seconds and neither
  // touches the brain, so the first question of a session used to pay the full
  // cold start — 11.7 s measured, against ~1.5 s warm. Firing it here means the
  // tube and the model heat up together, which is what the animation has always
  // implied was happening.
  //
  // NOT awaited, and never to be. The rule this file has paid for once is that
  // nothing goes in front of the picture: awaiting /api/settings to fix a small
  // sound problem stopped the warm-up appearing at all, reported as "it looks
  // like you just removed the startup sequence". A pre-load is an optimisation,
  // so it gets its own catch and the picture never knows about it.
  serverFetch("/api/warm", { method: "POST" }).catch(() => {});

  // Hold the greeting until the set has actually come on. He should not start
  // talking over his own POST screen. `.catch` rather than a bare await: this
  // is an animation, and nothing about it is worth losing the greeting over.
  await booting.catch(() => {});
  setTitle(config.name ?? "Greg");

  setMode("idle");
  await speak(
    config.hasBrain
      ? `${config.name} online. Say "Hey ${config.name}" whenever you need me.`
      : `${config.name} online, running in basic mode. Ask me about the weather or the local news.`
  );

  if (!config.hasBrain) el.hint.textContent = "Basic mode — start Ollama and restart Greg for full conversation.";
  else if (!micDebug && micEnabled) el.hint.textContent = readyHint;

  if (offline) return;
  setMode("idle");
  if (micEnabled) startListening();
}

el.wakeBtn.addEventListener("click", wake, { once: true });

face.start();
setMode("off");
