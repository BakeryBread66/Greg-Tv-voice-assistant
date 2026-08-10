"""
Greg's voice: a cloned one, from a short recording of a real person.

Same shape as piper_server.py — Node spawns it, watches stdout for READY, then
posts text to it over localhost. Nothing leaves this machine.

Two things differ from Piper and both matter:

  * It runs on the GPU and on its own Python. Chatterbox pins torch==2.6.0, which
    is older than the interpreter Greg's other sidecars use, so this one lives in
    .venv-clone on Python 3.12. Node passes that interpreter explicitly.

  * It is roughly 1.3x realtime against Piper's 9x. A sentence costs seconds, not
    milliseconds, which is why lib/tts-cache.js sits in front of it.
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

import numpy as np

ROOT = Path(__file__).resolve().parent
REFERENCE = Path(os.environ.get("GREG_CLONE_REFERENCE", ROOT / "voices" / "greg-reference.wav"))
PORT = int(os.environ.get("GREG_CLONE_PORT", "4750"))
DEVICE = os.environ.get("GREG_CLONE_DEVICE", "cuda")

# Measured on this reference (see CLAUDE.md): 0.3 is the flattest, most level
# delivery. Below that it does NOT get flatter — it gets draggy, with half-second
# gaps mid-sentence. Above ~0.7 the phrasing disappears entirely and it runs
# through the text in one breath, which is the thing that reads as robotic.
EXAGGERATION = float(os.environ.get("GREG_CLONE_EXAGGERATION", "0.5"))
CFG_WEIGHT = float(os.environ.get("GREG_CLONE_CFG_WEIGHT", "0.5"))
TEMPERATURE = float(os.environ.get("GREG_CLONE_TEMPERATURE", "0.8"))

if not REFERENCE.exists():
    print(f"ERROR reference clip not found: {REFERENCE}", flush=True)
    sys.exit(1)

import torch  # noqa: E402
from chatterbox.tts import ChatterboxTTS  # noqa: E402

if DEVICE == "cuda" and not torch.cuda.is_available():
    print("ERROR cuda requested but not available", flush=True)
    sys.exit(1)

MODEL = ChatterboxTTS.from_pretrained(device=DEVICE)
SAMPLE_RATE = MODEL.sr

# One model, several sentences in flight at once from the streaming path, and a
# ThreadingHTTPServer underneath. Same call as piper_server.py: serialize rather
# than gamble on the model being thread-safe.
SYNTHESIS_LOCK = threading.Lock()


def synthesize_wav(text):
    with SYNTHESIS_LOCK:
        wav = MODEL.generate(
            text,
            audio_prompt_path=str(REFERENCE),
            exaggeration=EXAGGERATION,
            cfg_weight=CFG_WEIGHT,
            temperature=TEMPERATURE,
        )
    audio = wav.squeeze().detach().cpu().numpy()
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(pcm.tobytes())
    return buffer.getvalue()


# The first generation carries one-time CUDA and kernel setup. Spend it here
# rather than on Greg's first reply, which is the one you always test.
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
            self._send_json(200, {
                "ok": True,
                "reference": REFERENCE.name,
                "sampleRate": SAMPLE_RATE,
                "exaggeration": EXAGGERATION,
            })
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
    print(f"READY reference={REFERENCE.stem} rate={SAMPLE_RATE} port={PORT}", flush=True)
    server.serve_forever()
