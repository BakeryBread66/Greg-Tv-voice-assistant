// The ears, and the front door — proven without a microphone.
//
// Everything Greg decides before a question reaches the model lives in two
// browser files, and until now neither was reachable from Node: the wake matcher
// sat inside voice.js, which touches `document` at import, and LocalListener was
// importable but untested. Four separate bugs have lived in this area across two
// sessions, and CLAUDE.md's plan for the listening core is explicitly "tests
// first, then rewrite the state model".
//
// LocalListener needs only `{ sampleRate }` and synthetic Float32Array frames.
// That is the whole trick: the level logic can be proven exactly even though the
// wiring around it cannot, because the browser pane has no microphone at all.
//
//     npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalize, afterWakeWord, isFiller, isCancel, isReplay, FILLER_PHRASES } from "../public/wake.js";
import { LocalListener } from "../public/listen-local.js";

// ---------------------------------------------------------------------------
// Wake word matching
// ---------------------------------------------------------------------------

const WAKE = ["hey greg"];

test("the wake word is found however it was punctuated or spaced", () => {
  for (const said of ["hey greg", "Hey Greg!", "  hey   greg  ", "hey, greg.", "HEY GREG"]) {
    assert.equal(afterWakeWord(said, WAKE), "", `"${said}" should wake him with no question`);
  }
});

test("what follows the wake word comes back, and nothing else does", () => {
  assert.equal(afterWakeWord("hey greg what time is it", WAKE), "what time is it");
  assert.equal(afterWakeWord("Hey Greg, what's the weather?", WAKE), "what's the weather");
  // Not for Greg — null, which is a different fact from "" (woken, no question).
  assert.equal(afterWakeWord("what time is it", WAKE), null);
  assert.equal(afterWakeWord("hey craig what time is it", WAKE), null);
});

test("a false start uses the LAST wake word, not the first", () => {
  // Otherwise the question becomes "no hey greg what time is it".
  assert.equal(
    afterWakeWord("hey greg — no, hey greg, what time is it", WAKE),
    "what time is it",
  );
});

test("where several wake words match, the one ending furthest along wins", () => {
  const both = ["greg", "hey greg"];
  assert.equal(afterWakeWord("hey greg what time is it", both), "what time is it");
});

test("a wake word that normalizes to nothing does not match everything", () => {
  // lastIndexOf("") returns the string length, so an entry of "!!!" used to match
  // every utterance ever spoken in the room and arm him on any noise. Settings
  // refuses zero wake words but does not refuse one made only of punctuation.
  assert.equal(afterWakeWord("turn the light on", ["!!!"]), null);
  assert.equal(afterWakeWord("turn the light on", []), null);
});

test("normalize keeps apostrophes and folds everything else", () => {
  // "what's" must stay one word — the filler guard counts words.
  assert.equal(normalize("What's up?!"), "what's up");
  assert.equal(normalize("  Hey,   GREG.  "), "hey greg");
  assert.equal(normalize("\they greg\n"), "hey greg");
});

// ---------------------------------------------------------------------------
// The filler guard — room tone must not ask questions
// ---------------------------------------------------------------------------

test("Whisper's inventions over room tone read as filler", () => {
  for (const said of ["you", "thank you", "thank you very much", "um", "ummmm", "hmm", "so", "okay", ""]) {
    assert.equal(isFiller(said), true, `"${said}" should be ignored inside the follow-up window`);
  }
});

test("every phrase in the filler list is actually caught by the guard", () => {
  // This is the test that found the bug. "thank you very much" was in the list
  // and could never match it: the word cap was 3 and the phrase is 4 words, so
  // the entry naming Whisper's most famous hallucination was dead code. Walking
  // the list is the only thing that could have shown it.
  for (const phrase of FILLER_PHRASES) {
    const said = phrase.replace(/\+$/, "").replace(/(.)\+/, "$1$1"); // "um+" -> "umm"
    assert.equal(isFiller(said), true, `"${said}" is in FILLER_PHRASES but slips through`);
  }
});

test("a real question that starts with a filler word is not filler", () => {
  assert.equal(isFiller("so what is the weather"), false);
  assert.equal(isFiller("okay play some music"), false);
  assert.equal(isFiller("what time is it"), false);
});

test("cancelling is the whole utterance, not a word inside it", () => {
  assert.equal(isCancel("never mind"), true);
  assert.equal(isCancel("stop"), true);
  assert.equal(isCancel("forget it"), true);
  // These are questions that happen to contain the word.
  assert.equal(isCancel("never mind the weather"), false);
  assert.equal(isCancel("stop the timer"), false);
});

// ---------------------------------------------------------------------------
// LocalListener — the level logic, driven by hand
// ---------------------------------------------------------------------------

const RATE = 48000;
const FRAME = 128; // the real worklet quantum

/** A listener wired to nothing, with a note of every utterance it emitted. */
function makeListener(options = {}) {
  const emitted = [];
  const activity = [];
  const listener = new LocalListener({
    audioCtx: { sampleRate: RATE },
    stream: null,
    onUtterance: (wav) => emitted.push(wav),
    onActivity: (speaking) => activity.push(speaking),
    ...options,
  });
  return { listener, emitted, activity };
}

/**
 * Push `seconds` of a signal at the given RMS through the listener.
 *
 * Alternating +a/-a, so the RMS is exactly the amplitude and every assertion
 * below is about a number the test chose rather than one it has to measure.
 */
function feed(listener, seconds, amplitude) {
  const frames = Math.round((seconds * RATE) / FRAME);
  for (let f = 0; f < frames; f++) {
    const block = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) block[i] = i % 2 === 0 ? amplitude : -amplitude;
    listener.consume(block);
  }
}

const ROOM = 0.0022; // a quiet room, as measured in CLAUDE.md
const TALK = 0.05;   // comfortably over any threshold below

test("in a quiet room it is minLevel that decides, not the noise floor", () => {
  const { listener } = makeListener();
  listener.enable();
  feed(listener, 5, ROOM);

  // The floor settles to about room tone, so floor * 3.5 lands under minLevel.
  assert.ok(listener.noiseFloor < 0.004, `floor settled to ${listener.noiseFloor}`);
  assert.ok(listener.noiseFloor * listener.floorMultiple < listener.minLevel);
  assert.equal(listener.threshold, listener.minLevel);
  assert.equal(listener.speaking, false, "room tone is not speech");
});

test("a loud room raises the bar instead of triggering constantly", () => {
  const { listener } = makeListener();
  listener.enable();
  feed(listener, 20, 0.01); // a noisy room, still under minLevel to start

  assert.ok(listener.threshold > listener.minLevel, "the floor should now be what binds");
  assert.equal(listener.speaking, false, "steady noise is not speech");
});

test("configured levels are honoured, and nonsense falls back", () => {
  const strict = makeListener({ floorMultiple: 6, minLevel: 0.05 }).listener;
  assert.equal(strict.floorMultiple, 6);
  assert.equal(strict.minLevel, 0.05);

  // A NaN from a text field would make the threshold permanently unsatisfiable,
  // with nothing on screen to explain why.
  const broken = makeListener({ floorMultiple: NaN, minLevel: undefined }).listener;
  assert.equal(broken.floorMultiple, 3.5);
  assert.equal(broken.minLevel, 0.012);
});

test("the level readout is live even while capture is switched off", () => {
  // "Is any sound arriving at all" is a different question from "is he
  // listening", and answering the first must not depend on the second — this is
  // what the ?mic panel reads.
  const { listener, emitted } = makeListener();
  assert.equal(listener.enabled, false);
  feed(listener, 0.5, TALK);

  assert.ok(listener.lastRms > 0.04, `lastRms was ${listener.lastRms}`);
  assert.equal(listener.speaking, false, "switched off means not listening");
  assert.equal(emitted.length, 0);
});

// ---------------------------------------------------------------------------
// sustainedLoudFor — a lingering flag is not a "right now" test
//
// `speaking` stays true for SILENCE_TO_END (850 ms) after the last loud frame so
// an utterance is not cut off mid-sentence. Barge-in waited 350 ms and then read
// that flag, which meant ANY single blip satisfied it — one cough, one keystroke.
// No value below 850 ms could ever have helped, which is why tuning it never
// worked. These are the cases from that investigation, as a standing battery.
// ---------------------------------------------------------------------------

test("a cough scores zero sustained loudness — while `speaking` is still true", () => {
  const { listener } = makeListener();
  listener.enable();
  feed(listener, 3, ROOM);

  feed(listener, 0.12, TALK); // a 120 ms cough
  feed(listener, 0.3, ROOM);  // shorter than SILENCE_TO_END, so the flag lingers

  assert.equal(listener.speaking, true, "the lingering flag is the bug in one line");
  assert.equal(listener.sustainedLoudFor(), 0, "but nothing is loud right now");
});

test("a keystroke scores zero", () => {
  const { listener } = makeListener();
  listener.enable();
  feed(listener, 3, ROOM);

  feed(listener, 0.01, TALK);
  feed(listener, 0.3, ROOM);

  assert.equal(listener.sustainedLoudFor(), 0);
});

test("two coughs 400 ms apart do not add up to a run", () => {
  const { listener } = makeListener();
  listener.enable();
  feed(listener, 3, ROOM);

  feed(listener, 0.1, TALK);
  feed(listener, 0.4, ROOM); // longer than LOUD_GAP, so the run is broken
  feed(listener, 0.1, TALK);

  // The second cough starts a fresh run, so at most its own length.
  assert.ok(listener.sustainedLoudFor() < 0.2, `scored ${listener.sustainedLoudFor()}`);
});

test("continuous talk builds a run barge-in can act on", () => {
  const { listener } = makeListener();
  listener.enable();
  feed(listener, 3, ROOM);

  feed(listener, 0.6, TALK);

  assert.ok(listener.sustainedLoudFor() > 0.5, `scored ${listener.sustainedLoudFor()}`);
});

test("the gaps between words do not break the run", () => {
  const { listener } = makeListener();
  listener.enable();
  feed(listener, 3, ROOM);

  for (let word = 0; word < 6; word++) {
    feed(listener, 0.12, TALK);
    feed(listener, 0.06, ROOM); // 60 ms between words, well inside LOUD_GAP
  }

  assert.ok(listener.sustainedLoudFor() > 0.5, `scored ${listener.sustainedLoudFor()}`);
});

// ---------------------------------------------------------------------------
// Capturing an utterance
// ---------------------------------------------------------------------------

test("an utterance is emitted once the talking stops", () => {
  const { listener, emitted, activity } = makeListener();
  listener.enable();
  feed(listener, 3, ROOM);

  feed(listener, 1.2, TALK);
  assert.equal(emitted.length, 0, "nothing is sent while you are still talking");

  feed(listener, 1.0, ROOM); // past SILENCE_TO_END

  assert.equal(emitted.length, 1);
  assert.deepEqual(activity, [true, false]);
  assert.equal(emitted[0].type, "audio/wav");
  // 16 kHz mono 16-bit: roughly the spoken length plus pre-roll and hangover.
  const seconds = (emitted[0].size - 44) / 2 / 16000;
  assert.ok(seconds > 1.2 && seconds < 2.5, `captured ${seconds.toFixed(2)}s`);
});

test("a noise too short to be speech is not sent to Whisper", () => {
  const { listener, emitted } = makeListener();
  listener.enable();
  feed(listener, 3, ROOM);

  feed(listener, 0.15, TALK); // under MIN_SPEECH
  feed(listener, 1.0, ROOM);

  assert.equal(listener.speaking, false, "the run ended");
  assert.equal(emitted.length, 0, "but there was nothing worth transcribing");
});

test("one long noise cannot record forever", () => {
  const { listener, emitted } = makeListener();
  listener.enable();
  feed(listener, 3, ROOM);

  feed(listener, 18, TALK); // past MAX_SPEECH

  assert.equal(emitted.length, 1, "cut off at the hard stop rather than running on");
});

test("disabling mid-utterance reports that he stopped listening", () => {
  const { listener, activity } = makeListener();
  listener.enable();
  feed(listener, 3, ROOM);
  feed(listener, 0.5, TALK);

  assert.equal(listener.speaking, true);
  listener.disable();

  assert.equal(listener.speaking, false);
  assert.deepEqual(activity, [true, false], "the face must not be left mid-listen");
});

test("'what?' asks for the same sentence again, not a new one", () => {
  // Re-running the model gets you a DIFFERENT answer, which is not what someone
  // who missed it is asking for. These replay the audio instead.
  for (const said of [
    "what", "huh", "sorry", "pardon", "again", "repeat that",
    "say that again", "say it again", "come again", "what was that",
    "what did you say", "i didn't catch that",
  ]) {
    assert.equal(isReplay(said), true, `"${said}" should replay`);
  }
});

test("a real question that starts the same way is not a replay", () => {
  // Anchored for exactly this reason: "what" alone means "I missed that", and
  // "what time is it" is a question that must still reach the model.
  for (const said of [
    "what time is it", "what's the weather", "what did I ask you yesterday",
    "say that in french", "repeat the alarm every morning", "sorry i meant tomorrow",
    "again what is the news",
  ]) {
    assert.equal(isReplay(said), false, `"${said}" is a question, not a replay`);
  }
});

// ---------------------------------------------------------------------------
// Telling somebody how to unblock a microphone in a window that has no
// address bar
//
// Greg opens Chrome with `--app=`, so his window has no address bar - the
// comment in server.js says so outright. The blocked-microphone message told
// people to "click the padlock in the address bar", which is the one piece of
// advice in the project that could not be followed in the window almost
// everybody sees him in.
//
// Found by somebody else's install. It could never have shown up here: once
// permission is granted for an origin it stays granted, so the author's window
// never produced the message at all.
// ---------------------------------------------------------------------------

import { micProblem, hasAddressBar } from "../public/mic-help.js";

const blocked = { name: "NotAllowedError" };

test("a window WITH an address bar is told about the padlock", () => {
  const said = micProblem(blocked, { hasAddressBar: true, origin: "http://localhost:4747" });
  assert.match(said, /padlock/);
  assert.match(said, /address bar/);
});

test("a window WITHOUT one is given a route that actually exists", () => {
  const said = micProblem(blocked, { hasAddressBar: false, origin: "http://localhost:4747" });
  assert.doesNotMatch(said, /padlock/, "there is no padlock in an app window");
  // The remedy has to name where to go, or it is just a restatement of the fault.
  assert.match(said, /http:\/\/localhost:4747/);
  assert.match(said, /ordinary browser tab/);
});

test("the app-window message still says something useful with no origin", () => {
  const said = micProblem(blocked, { hasAddressBar: false });
  assert.doesNotMatch(said, /undefined|null/, "a missing origin must not leak into the advice");
  assert.match(said, /his address/);
});

test("the other faults are unchanged, and do not mention the address bar", () => {
  for (const name of ["NotFoundError", "OverconstrainedError", "NotReadableError"]) {
    for (const bar of [true, false]) {
      const said = micProblem({ name }, { hasAddressBar: bar });
      assert.ok(said && said.length > 20, `${name} should still explain itself`);
      assert.doesNotMatch(said, /padlock/, `${name} is not a permissions problem`);
    }
  }
});

test("an unknown fault names itself rather than guessing", () => {
  assert.match(micProblem({ name: "WeirdError" }, {}), /WeirdError/);
  assert.equal(micProblem(null), null, "no error is not a problem to report");
});

test("defaulting to 'there is an address bar' is the safer way to be wrong", () => {
  // Told about a padlock you DO have is a smaller failure than being told about
  // one you do not, so a caller that forgets the option gets the ordinary advice.
  assert.match(micProblem(blocked), /padlock/);
});

test("an app window is detected by the standard property", () => {
  assert.equal(hasAddressBar({ locationbar: { visible: false } }), false, "Chrome --app= window");
  assert.equal(hasAddressBar({ locationbar: { visible: true } }), true, "an ordinary tab");
  // Anything unexpected must read as a normal window, per the rule above.
  assert.equal(hasAddressBar({}), true);
  assert.equal(hasAddressBar(undefined), true);
});
