// Greg on a phone.
//
// Hold the button and talk; let go and it is sent to Greg's PC, which hears it
// with its own Whisper, answers with its own brain, and speaks with its own
// voice — the phone only records and plays. Everything goes to the phone server
// (lib/phone-server.js) with this phone's token, which it got by pairing.
//
// From here Greg cannot see the PC's screen or read its files: that is enforced
// on the PC, not here (PHONE_BLOCKED in lib/brain.js). This page could not
// grant it if it tried.

import { downsample, encodeWav, TARGET_RATE } from "/listen-local.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "greg-phone-token";

// localStorage can be missing or throw (private browsing, storage cleared):
// then the phone simply has to pair again, rather than the page failing.
const stored = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (value) => {
    try {
      localStorage.setItem(TOKEN_KEY, value);
    } catch {
      /* this session only */
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};

let token = stored.get();
let hello = null;

class Unreachable extends Error {}
class Unpaired extends Error {}

function setState(text, bad = false) {
  $("state").textContent = text;
  $("state").classList.toggle("bad", bad);
}

async function api(path, { method = "GET", json, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body });
  } catch {
    throw new Unreachable();
  }
  if (res.status === 401 && path !== "/api/pair") {
    forgetPairing("This phone was removed from Greg's Settings, so it needs pairing again.");
    throw new Unpaired();
  }
  return res;
}

function explain(err) {
  if (err instanceof Unpaired) return;
  if (err instanceof Unreachable) {
    setState("can't reach Greg", true);
    note("Can't reach Greg. Is the PC on and awake, is Greg running, and is Tailscale connected on both?");
  } else {
    note(err.message || "Something went wrong.");
  }
}

function note(text) {
  $("talk-note").textContent = text ?? "";
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

function showPair(problem) {
  $("talk").hidden = true;
  $("pair").hidden = false;
  setState("not paired");
  const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
  $("install-first").hidden = !(iphone && !navigator.standalone);
  const box = $("pair-problem");
  box.textContent = problem ?? "";
  box.hidden = !problem;
}

function forgetPairing(problem) {
  token = null;
  hello = null;
  stored.clear();
  showPair(problem);
}

async function pair() {
  const code = $("pair-code").value.replace(/\D/g, "");
  const name = $("pair-name").value.trim() || guessName();
  if (code.length !== 6) return showPair("The code is six digits.");
  $("pair-go").disabled = true;
  try {
    const res = await api("/api/pair", { method: "POST", json: { code, name } });
    const result = await res.json();
    if (!res.ok) return showPair(result.error ?? "That didn't work.");
    token = result.token;
    stored.set(token);
    $("pair-code").value = "";
    await connect();
  } catch (err) {
    showPair(err instanceof Unreachable ? "Can't reach Greg. Is Tailscale connected on this phone?" : err.message);
  } finally {
    $("pair-go").disabled = false;
  }
}

function guessName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "Phone";
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

async function connect() {
  $("pair").hidden = true;
  $("talk").hidden = false;
  setState("connecting…");
  try {
    const res = await api("/api/hello");
    hello = await res.json();
    setState(`connected to ${hello.name}`);
    note("");
    if (!$("log").children.length) addLine("info", `Paired as “${hello.phone}”. Hold the button and talk.`);
    await paintNotify();
  } catch (err) {
    explain(err);
  }
}

// ---------------------------------------------------------------------------
// The conversation on screen
// ---------------------------------------------------------------------------

function addLine(kind, text) {
  const li = document.createElement("li");
  li.className = kind;
  li.textContent = text;
  $("log").append(li);
  li.scrollIntoView({ block: "end" });
  return li;
}

// ---------------------------------------------------------------------------
// Sound: one AudioContext, resumed from a tap — the only way iOS allows it
// ---------------------------------------------------------------------------

let ctx = null;
async function audio() {
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") await ctx.resume();
  return ctx;
}

// Every answer gets a generation number; interrupting bumps it, and anything
// still queued for an older generation is dropped rather than played.
let generation = 0;
let playing = null; // the AudioBufferSourceNode currently sounding
let speechChain = Promise.resolve();
let chatAbort = null;

function interrupt() {
  generation += 1;
  chatAbort?.abort();
  chatAbort = null;
  try {
    playing?.stop();
  } catch {
    /* already ended */
  }
  playing = null;
  speechChain = Promise.resolve();
}

/** Start fetching a sentence's audio now; play it when its turn comes. */
function queueSpeech(sentence, gen) {
  const fetched = api("/api/tts", { method: "POST", json: { text: sentence } })
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .catch(() => null);
  speechChain = speechChain.then(async () => {
    const data = await fetched;
    if (!data || gen !== generation) return;
    try {
      const c = await audio();
      const decoded = await c.decodeAudioData(data);
      if (gen !== generation) return;
      await new Promise((resolve) => {
        const source = c.createBufferSource();
        source.buffer = decoded;
        source.connect(c.destination);
        source.onended = resolve;
        playing = source;
        source.start();
      });
    } catch {
      /* one sentence that won't play is not worth stopping the rest for */
    }
  });
  return speechChain;
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

function setBusy(label) {
  const hold = $("hold");
  hold.classList.toggle("busy", Boolean(label));
  hold.querySelector(".hold-label").textContent = label || "Hold to talk";
}

async function ask(text) {
  interrupt();
  const gen = generation;
  addLine("you", text);
  const line = addLine("greg", "…");
  let said = "";
  setBusy("Thinking…");
  chatAbort = new AbortController();

  try {
    let res;
    try {
      res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text }),
        signal: chatAbort.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") return;
      throw new Unreachable();
    }
    if (res.status === 401) {
      forgetPairing("This phone was removed from Greg's Settings, so it needs pairing again.");
      return;
    }
    if (!res.ok || !res.body) throw new Error(`Greg answered with an error (${res.status}).`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const raw of frame.split("\n")) {
          if (!raw.startsWith("data:")) continue;
          let event;
          try {
            event = JSON.parse(raw.slice(5).trim());
          } catch {
            continue;
          }
          if (gen !== generation) return;
          if (event.type === "sentence" && event.text) {
            said = said ? `${said} ${event.text}` : event.text;
            line.textContent = said;
            line.scrollIntoView({ block: "end" });
            setBusy("Hold to interrupt");
            queueSpeech(event.text, gen);
          } else if (event.type === "done" && !said && event.reply) {
            line.textContent = event.reply;
            queueSpeech(event.reply, gen);
          }
        }
      }
    }
    await speechChain;
  } catch (err) {
    if (err?.name === "AbortError") return;
    line.textContent = "(no answer)";
    explain(err);
  } finally {
    if (gen === generation) setBusy("");
  }
}

// ---------------------------------------------------------------------------
// Holding the button: record, then send
// ---------------------------------------------------------------------------

let mic = null;
let workletReady = false;
let recorder = null; // { source, node, sink, chunks }

async function startRecording() {
  const c = await audio();
  mic ??= await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  if (!workletReady) {
    await c.audioWorklet.addModule("/recorder-worklet.js");
    workletReady = true;
  }
  const source = c.createMediaStreamSource(mic);
  const node = new AudioWorkletNode(c, "recorder");
  // Wired to the output through silence: some browsers stop running a node
  // that leads nowhere, and silence means you never hear yourself.
  const sink = c.createGain();
  sink.gain.value = 0;
  const chunks = [];
  node.port.onmessage = (event) => chunks.push(event.data);
  source.connect(node);
  node.connect(sink);
  sink.connect(c.destination);
  recorder = { source, node, sink, chunks, rate: c.sampleRate };
}

function stopRecording() {
  const r = recorder;
  recorder = null;
  if (!r) return null;
  try {
    r.source.disconnect();
    r.node.disconnect();
    r.sink.disconnect();
    r.node.port.close();
  } catch {
    /* already gone */
  }
  const length = r.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (length < r.rate * 0.3) return null; // a tap, not a sentence
  const samples = new Float32Array(length);
  let at = 0;
  for (const chunk of r.chunks) {
    samples.set(chunk, at);
    at += chunk.length;
  }
  return encodeWav(downsample(samples, r.rate, TARGET_RATE), TARGET_RATE);
}

async function hear(wav) {
  setBusy("Listening…");
  try {
    const res = await api("/api/transcribe", { method: "POST", body: wav });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error ?? "Greg couldn't hear that.");
    const text = String(result.text ?? "").trim();
    if (!text) {
      addLine("info", "Didn't catch that.");
      setBusy("");
      return;
    }
    await ask(text);
  } catch (err) {
    setBusy("");
    explain(err);
  }
}

let holding = false;

async function press(event) {
  event.preventDefault();
  if (holding || !token) return;
  holding = true;
  interrupt();
  $("hold").classList.add("recording");
  $("hold").querySelector(".hold-label").textContent = "Listening — let go to send";
  try {
    $("hold").setPointerCapture?.(event.pointerId);
    await startRecording();
    // Let go before the microphone even opened: that was a tap.
    if (!holding) stopRecording();
  } catch (err) {
    holding = false;
    $("hold").classList.remove("recording");
    setBusy("");
    note(err.name === "NotAllowedError" ? "Greg needs the microphone. Allow it in this browser's settings, then try again." : `The microphone didn't start: ${err.message}`);
  }
}

function release(event) {
  event?.preventDefault?.();
  if (!holding) return;
  holding = false;
  $("hold").classList.remove("recording");
  const wav = stopRecording();
  if (wav) hear(wav);
  else setBusy("");
}

// ---------------------------------------------------------------------------
// Reminders as notifications
// ---------------------------------------------------------------------------

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function keyBytes(base64url) {
  const text = atob(base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "="));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

// getRegistration, never `serviceWorker.ready`: ready waits for a worker that
// may never exist — if registering it failed, it waits forever, and the button
// below would never be painted.
const workerRegistration = () => navigator.serviceWorker.getRegistration("/phone/");

async function currentSubscription() {
  if (!pushSupported()) return null;
  const registration = await workerRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

async function paintNotify() {
  const button = $("notify");
  if (!pushSupported() || !(await workerRegistration())) {
    button.textContent = "Reminders: not here";
    button.disabled = true;
    return;
  }
  const subscribed = Boolean(await currentSubscription()) && hello?.notifications !== false;
  button.textContent = subscribed ? "Reminders: on" : "Remind me here";
  button.disabled = false;
}

async function toggleNotify() {
  if (!pushSupported()) {
    note(/iPhone|iPad/.test(navigator.userAgent)
      ? "On an iPhone, reminders need Greg added to the Home Screen: Share, then Add to Home Screen, then pair from there."
      : "This browser can't show Greg's reminders.");
    return;
  }
  try {
    const registration = await workerRegistration();
    if (!registration) {
      note("Reminders couldn't start in this browser. Talking still works.");
      return;
    }
    const existing = await registration.pushManager.getSubscription();
    if (existing && hello?.notifications) {
      await existing.unsubscribe();
      await api("/api/push", { method: "POST", json: { subscription: null } });
      hello.notifications = false;
      note("Reminders will only be spoken on the PC.");
      return paintNotify();
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      note("Notifications are blocked for Greg. Allow them in this phone's settings to get reminders here.");
      return;
    }
    // A subscription made for an older key would be refused; start clean.
    if (existing) await existing.unsubscribe();
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(hello.pushKey),
    });
    const res = await api("/api/push", { method: "POST", json: { subscription: subscription.toJSON() } });
    if (!res.ok) throw new Error((await res.json()).error ?? "Greg couldn't turn reminders on.");
    hello.notifications = true;
    note("Your reminders and timers will pop up here too.");
    await paintNotify();
  } catch (err) {
    explain(err);
  }
}

async function unpair() {
  if (!confirm("Unpair this phone? You'll need a new code from the PC to use it again.")) return;
  try {
    await api("/api/unpair", { method: "POST", json: {} });
  } catch {
    /* removed here regardless */
  }
  try {
    await (await currentSubscription())?.unsubscribe();
  } catch {
    /* nothing subscribed */
  }
  forgetPairing();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

$("pair-go").addEventListener("click", pair);
$("pair-code").addEventListener("keydown", (event) => event.key === "Enter" && pair());

const hold = $("hold");
hold.addEventListener("pointerdown", press);
hold.addEventListener("pointerup", release);
hold.addEventListener("pointercancel", release);
hold.addEventListener("contextmenu", (event) => event.preventDefault());

$("type-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("type").value.trim();
  if (!text) return;
  $("type").value = "";
  await audio(); // this tap is what lets the answer be heard on iOS
  ask(text);
});

$("notify").addEventListener("click", toggleNotify);
$("unpair").addEventListener("click", unpair);

// Let go of the microphone whenever the app is put away: the phone's
// microphone light should mean Greg is listening, and nothing else.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") {
    if (token && !hello) connect();
    return;
  }
  release();
  interrupt();
  mic?.getTracks().forEach((track) => track.stop());
  mic = null;
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {
    /* notifications unavailable; talking still works */
  });
}

if (token) connect();
else showPair();
