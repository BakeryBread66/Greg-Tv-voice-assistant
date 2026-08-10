// Offline listening.
//
// Keeps a rolling buffer of microphone audio, watches the signal level to decide
// when you started and stopped talking, then sends just that slice to Greg's
// local Whisper for transcription. Nothing goes to the cloud.
//
// The rolling buffer matters: speech is only detected a moment *after* it starts,
// so without a bit of history the first syllable — usually "Hey" — gets cut off.

const TARGET_RATE = 16000; // what Whisper wants; also keeps uploads small
const PRE_ROLL = 0.35;     // seconds of audio kept from before speech was detected
const HANG_OVER = 0.25;    // seconds kept after it stops
const SILENCE_TO_END = 0.85;
const MIN_SPEECH = 0.3;    // ignore coughs and door clicks
const MAX_SPEECH = 15;     // hard stop so one noise can't record forever

// The longest gap that still counts as the same run of talking. Wide enough for
// the pause between words, far too short to bridge a cough and the silence after
// it. Used only by sustainedLoudFor() below.
const LOUD_GAP = 0.2;

export class LocalListener {
  /**
   * @param {object} options
   * @param {AudioContext} options.audioCtx
   * @param {MediaStream} options.stream
   * @param {(wav: Blob) => void} options.onUtterance
   * @param {(speaking: boolean) => void} [options.onActivity]
   */
  constructor({ audioCtx, stream, onUtterance, onActivity, floorMultiple, minLevel }) {
    this.audioCtx = audioCtx;
    this.stream = stream;
    this.onUtterance = onUtterance;
    this.onActivity = onActivity ?? (() => {});
    // How far above the rolling noise floor counts as speech. Tunable because
    // the right value depends on the microphone and how close you sit to it.
    this.floorMultiple = floorMultiple > 0 ? floorMultiple : 3.5;
    this.minLevel = minLevel > 0 ? minLevel : 0.012;

    this.rate = audioCtx.sampleRate;
    this.buffer = new Float32Array(Math.ceil(this.rate * 20)); // 20s ring buffer
    this.written = 0;

    this.enabled = false;
    this.speaking = false;
    this.speechStart = 0;
    this.lastLoud = 0;
    this.loudSince = 0;
    this.noiseFloor = 0.006;
    this.node = null;

    // For the ?mic readout only — nothing reads these to make a decision. They
    // exist because "he can't hear me" has four different causes that look
    // identical from outside the browser: the wrong input device, a signal that
    // never clears the floor, capture that is switched off, and speech that is
    // heard but transcribes to nothing.
    this.lastRms = 0;
    this.threshold = 0;
  }

  /**
   * How long the microphone has been CONTINUOUSLY loud, in seconds.
   *
   * Deliberately not the same question as `speaking`. That flag lingers for
   * SILENCE_TO_END (0.85 s) after the last loud frame so an utterance isn't cut
   * off mid-sentence — which means it stays true long after a single cough, and
   * anything shorter than 0.85 s that tests it is really testing nothing.
   * Barge-in needs to know you are talking *right now*, and for how long.
   */
  sustainedLoudFor() {
    const now = this.written / this.rate;
    if (!this.loudSince || now - this.lastLoud > LOUD_GAP) return 0;
    return now - this.loudSince;
  }

  async start() {
    await this.audioCtx.audioWorklet.addModule("/recorder-worklet.js");
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.audioCtx, "recorder");
    this.node.port.onmessage = (event) => this.consume(event.data);
    source.connect(this.node);
    // Not connected to the destination — we don't want to hear ourselves.
  }

  enable() {
    this.enabled = true;
  }

  /**
   * Disconnect from the audio graph for good.
   *
   * Needed to change microphone without reloading: the worklet node stays wired
   * to the old stream's source otherwise, and a second listener on a second
   * device would leave both feeding the same ring buffer.
   */
  stop() {
    this.disable();
    try {
      this.node?.disconnect();
      this.node?.port?.close();
    } catch {
      // Already torn down, or the context is gone — nothing to salvage.
    }
    this.node = null;
  }

  disable() {
    this.enabled = false;
    if (this.speaking) {
      this.speaking = false;
      this.onActivity(false);
    }
  }

  consume(samples) {
    // Write into the ring buffer regardless, so pre-roll is always available.
    for (let i = 0; i < samples.length; i++) {
      this.buffer[(this.written + i) % this.buffer.length] = samples[i];
    }
    this.written += samples.length;

    // Measured before the enabled check, so the readout can show a live level
    // even while capture is switched off — "is any sound arriving at all" is a
    // different question from "is he listening", and answering the first one
    // needs no permission from the second.
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    this.lastRms = rms;

    if (!this.enabled) return;

    const now = this.written / this.rate;

    // Track the quiet level so a noisy room raises the bar instead of
    // triggering constantly.
    if (!this.speaking) {
      this.noiseFloor = rms < this.noiseFloor ? this.noiseFloor * 0.9 + rms * 0.1 : this.noiseFloor * 0.995 + rms * 0.005;
    }
    const threshold = Math.max(this.noiseFloor * this.floorMultiple, this.minLevel);
    this.threshold = threshold;

    if (rms > threshold) {
      // A gap longer than LOUD_GAP means this is a fresh run of talking, not a
      // continuation of the last one.
      if (now - this.lastLoud > LOUD_GAP) this.loudSince = now;
      this.lastLoud = now;
      if (!this.speaking) {
        this.speaking = true;
        this.speechStart = now;
        this.onActivity(true);
      }
    }

    if (!this.speaking) return;

    const talkedFor = now - this.speechStart;
    const quietFor = now - this.lastLoud;

    if (quietFor > SILENCE_TO_END || talkedFor > MAX_SPEECH) {
      this.speaking = false;
      this.onActivity(false);
      const spoken = this.lastLoud - this.speechStart;
      if (spoken >= MIN_SPEECH) this.emit(this.speechStart - PRE_ROLL, this.lastLoud + HANG_OVER);
    }
  }

  emit(fromSeconds, toSeconds) {
    const from = Math.max(0, Math.floor(fromSeconds * this.rate));
    const to = Math.min(this.written, Math.floor(toSeconds * this.rate));
    const length = to - from;
    if (length <= 0) return;

    // Pull the slice back out of the ring buffer in order.
    const slice = new Float32Array(length);
    for (let i = 0; i < length; i++) slice[i] = this.buffer[(from + i) % this.buffer.length];

    this.onUtterance(encodeWav(downsample(slice, this.rate, TARGET_RATE), TARGET_RATE));
  }
}

// Average groups of samples rather than dropping them — avoids aliasing that
// would make the transcription worse.
function downsample(samples, fromRate, toRate) {
  if (toRate >= fromRate) return samples;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);  // PCM
  view.setUint16(22, 1, true);  // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}
