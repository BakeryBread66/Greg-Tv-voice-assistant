// Captures every microphone sample and hands it to the main thread.
//
// An AnalyserNode only exposes snapshots, so it drops audio between animation
// frames — no good for recording. This sees the whole stream.

class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length) {
      // Copy: the underlying buffer is reused by the audio thread.
      this.port.postMessage(new Float32Array(channel));
    }
    return true;
  }
}

registerProcessor("recorder", RecorderProcessor);
