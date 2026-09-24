# Speaks every phrase in several Piper voices, for the ears benchmark.
# Writes 16 kHz mono 16-bit WAV — what Greg's page actually sends to Whisper.
import json
import sys
import wave
from pathlib import Path

import numpy as np
from piper import PiperVoice

HERE = Path(__file__).parent
VOICES = Path(sys.argv[1] if len(sys.argv) > 1 else HERE.parent.parent / "voices")
OUT = HERE / "clips"
OUT.mkdir(exist_ok=True)
phrases = json.loads((HERE / "phrases.json").read_text(encoding="utf-8"))
speakers = [
    "en_GB-alan-medium",
    "en_GB-northern_english_male-medium",
    "en_US-hfc_male-medium",
    "en_US-joe-medium",
    "en_US-john-medium",
    "en_US-norman-medium",
]


def to_16k(samples, rate):
    """Average-downsample, the way public/listen-local.js does."""
    x = samples.astype(np.float32) / 32768.0
    if rate == 16000:
        return x
    ratio = rate / 16000
    n = int(len(x) / ratio)
    out = np.empty(n, dtype=np.float32)
    for i in range(n):
        a = int(i * ratio)
        b = min(int((i + 1) * ratio), len(x))
        out[i] = x[a:b].mean() if b > a else 0.0
    return out


for name in speakers:
    voice = PiperVoice.load(str(VOICES / f"{name}.onnx"))
    rate = voice.config.sample_rate
    for i, text in enumerate(phrases):
        chunks = [c.audio_int16_array for c in voice.synthesize(text)]
        audio = to_16k(np.concatenate(chunks), rate)
        # Half a second of quiet either side, as a real utterance would have.
        pad = np.zeros(8000, dtype=np.float32)
        audio = np.concatenate([pad, audio, pad])
        pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
        with wave.open(str(OUT / f"{name}__{i:02d}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(pcm.tobytes())
    print(name, "done", flush=True)
