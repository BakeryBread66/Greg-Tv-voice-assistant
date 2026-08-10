"""
Greg's voice: a small local text-to-speech service.

Node starts this automatically and talks to it over localhost, the same shape as
whisper_server.py. The voice model stays resident because loading it costs about
a second, which you'd otherwise pay on every reply.

Unlike the Edge fallback in lib/tts-edge.js, nothing leaves this machine.
"""

import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VOICE_NAME = os.environ.get("GREG_PIPER_VOICE", "en_US-ryan-high")
VOICES_DIR = Path(os.environ.get("GREG_PIPER_VOICES_DIR", ROOT / "voices"))
PORT = int(os.environ.get("GREG_PIPER_PORT", "4749"))
# Piper's "length scale" is inverse speed: smaller is faster. Node passes the
# reciprocal of a friendlier "speed" number so config.json can say 1.05.
LENGTH_SCALE = float(os.environ.get("GREG_PIPER_LENGTH_SCALE", "1.0"))
SPEAKER = os.environ.get("GREG_PIPER_SPEAKER", "")
NOISE_SCALE = os.environ.get("GREG_PIPER_NOISE_SCALE", "")
NOISE_W_SCALE = os.environ.get("GREG_PIPER_NOISE_W_SCALE", "")

from piper import PiperVoice, SynthesisConfig  # noqa: E402


def ensure_voice():
    """
    Find the voice model, downloading it on first run.

    A voice is two files — the ONNX model and its JSON config — and Piper needs
    both. Either one missing means fetch the pair again.
    """
    model = VOICES_DIR / f"{VOICE_NAME}.onnx"
    if model.exists() and (VOICES_DIR / f"{VOICE_NAME}.onnx.json").exists():
        return model

    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    # Node watches for this and tells the user why startup is slow: it's a ~63 MB
    # download and otherwise looks like a hang.
    print(f"DOWNLOADING voice={VOICE_NAME}", flush=True)

    from piper.download_voices import download_voice

    download_voice(VOICE_NAME, VOICES_DIR)
    return model


def build_config():
    """Turn the environment into a SynthesisConfig, leaving unset knobs at the model's own defaults."""
    settings = {"length_scale": LENGTH_SCALE, "normalize_audio": True}
    if SPEAKER:
        settings["speaker_id"] = int(SPEAKER)
    if NOISE_SCALE:
        settings["noise_scale"] = float(NOISE_SCALE)
    if NOISE_W_SCALE:
        settings["noise_w_scale"] = float(NOISE_W_SCALE)
    return SynthesisConfig(**settings)


MODEL_PATH = ensure_voice()
# CPU deliberately: the installed onnxruntime is the CPU build, and Piper already
# synthesizes at roughly 40x realtime here. Using the GPU would mean a second
# CUDA-dependent process fighting Whisper for VRAM to save milliseconds we don't
# need. (See CLAUDE.md on how much trouble Whisper's CUDA DLLs were.)
VOICE = PiperVoice.load(MODEL_PATH, use_cuda=False)
SYNTHESIS = build_config()
SAMPLE_RATE = VOICE.config.sample_rate


# Streaming speech sends one request per sentence, so several can now be in
# flight at once — and this is a ThreadingHTTPServer. One voice object shared
# across threads is not worth gambling on, and synthesis is fast enough that
# serializing costs nothing next to a corrupt or crashed session.
SYNTHESIS_LOCK = threading.Lock()


def synthesize_wav(text):
    buffer = io.BytesIO()
    with SYNTHESIS_LOCK:
        with wave.open(buffer, "wb") as wav:
            VOICE.synthesize_wav(text, wav, syn_config=SYNTHESIS)
    return buffer.getvalue()


# The first synthesis after loading costs about a second of one-time setup inside
# onnxruntime. Spend it now, during startup, rather than on Greg's first reply.
synthesize_wav("Hello.")


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"ok": True, "voice": VOICE_NAME, "sampleRate": SAMPLE_RATE})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/speak":
            return self._send_json(404, {"error": "not found"})

        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return self._send_json(400, {"error": "no text"})

        try:
            text = json.loads(self.rfile.read(length)).get("text", "")
        except (ValueError, AttributeError):
            return self._send_json(400, {"error": "invalid JSON"})

        text = str(text).strip()
        if not text:
            return self._send_json(400, {"error": "no text"})

        started = time.time()
        try:
            audio = synthesize_wav(text)
        except Exception as exc:  # noqa: BLE001
            return self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("X-Synthesis-Ms", str(int((time.time() - started) * 1000)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, *args):
        pass  # Node owns the console


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    # Node watches stdout for this line before sending any text.
    print(f"READY voice={VOICE_NAME} rate={SAMPLE_RATE} port={PORT}", flush=True)
    server.serve_forever()
