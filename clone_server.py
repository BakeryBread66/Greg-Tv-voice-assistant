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
PRECISION = os.environ.get("GREG_CLONE_PRECISION", "auto").lower()

if not REFERENCE.exists():
    print(f"ERROR reference clip not found: {REFERENCE}", flush=True)
    sys.exit(1)

import torch  # noqa: E402
from chatterbox.tts import ChatterboxTTS  # noqa: E402

if DEVICE == "cuda" and not torch.cuda.is_available():
    print("ERROR cuda requested but not available", flush=True)
    sys.exit(1)

# Half precision, and ONLY on the t3 backbone. Measured on this machine against
# the same sentence and seed: 3801 MiB resident falls to 2826, peak 4163 to
# 3074, with synthesis unchanged at ~1.47x realtime and the output level within
# 0.1 dB. That is a gigabyte of somebody's card for no audible cost.
#
# s3gen stays in fp32 and that is not caution, it is a result. Hard-casting it
# fails outright with a dtype mismatch, and the autocast version that does run
# renders 1.6 dB louder and was described by the person listening as "rushed and
# barely coherent" -- while duration, RMS and non-finite counts all still looked
# fine. Every number said yes and the ear said no. Do not re-litigate this from
# the metrics; the extra ~400 MiB is not for sale.
#
# CPU keeps fp32: half precision there is slower rather than faster, and system
# memory is not the resource anybody is short of.
if PRECISION == "auto":
    PRECISION = "fp16" if DEVICE == "cuda" else "fp32"
if PRECISION not in ("fp16", "fp32"):
    print(f"ERROR unknown precision '{PRECISION}' — use fp16, fp32 or auto", flush=True)
    sys.exit(1)
HALF = PRECISION == "fp16" and DEVICE == "cuda"

# Load on the CPU when casting, so the card never holds the fp32 copy at all.
# Loading onto the GPU and casting there works and settles at the same figure,
# but it spends 3801 MiB on the way -- which is fine on a large card and is
# exactly the transient that would fail on the small ones this exists for.
MODEL = ChatterboxTTS.from_pretrained(device="cpu" if HALF else DEVICE)
SAMPLE_RATE = MODEL.sr

# Read the reference ONCE. generate() rebuilds the conditionals from the clip on
# every call when handed audio_prompt_path, which re-reads and re-embeds the
# whole recording per sentence -- and rebuilds them in fp32, which would undo
# the cast below on the first reply. Preparing them here is what makes half
# precision possible, and it drops the per-sentence cost of the reference too.
MODEL.prepare_conditionals(str(REFERENCE), exaggeration=EXAGGERATION)

if HALF:
    MODEL.t3 = MODEL.t3.half()
    cond = MODEL.conds.t3
    cond.speaker_emb = cond.speaker_emb.half()
    cond.emotion_adv = cond.emotion_adv.half()
    for name in ("clap_emb", "cond_prompt_speech_emb"):
        value = getattr(cond, name, None)
        if torch.is_tensor(value) and value.is_floating_point():
            setattr(cond, name, value.half())

    MODEL.t3.to(DEVICE)
    MODEL.s3gen.to(DEVICE)
    MODEL.ve.to(DEVICE)
    MODEL.conds.to(DEVICE)
    MODEL.device = DEVICE
    torch.cuda.empty_cache()

# generate() rebuilds the conditionals -- in fp32 -- whenever the exaggeration it
# is passed differs from the one they were built with. Half cannot hold most
# values exactly (0.3 stores as 0.30004883), so passing the configured number
# back would trip that comparison and crash on a dtype mismatch, for every
# setting except the few that happen to round-trip. Read the value back out of
# the tensor and pass exactly that, so the test is always false.
EFFECTIVE_EXAGGERATION = float(MODEL.conds.t3.emotion_adv[0, 0, 0])

# One model, several sentences in flight at once from the streaming path, and a
# ThreadingHTTPServer underneath. Same call as piper_server.py: serialize rather
# than gamble on the model being thread-safe.
SYNTHESIS_LOCK = threading.Lock()


def synthesize_wav(text):
    with SYNTHESIS_LOCK:
        # No audio_prompt_path: the conditionals were built once at startup and
        # rebuilding them here would re-read the reference and drop back to fp32.
        wav = MODEL.generate(
            text,
            exaggeration=EFFECTIVE_EXAGGERATION,
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
                "precision": PRECISION,
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
    # Precision is reported rather than assumed by the caller: it is resolved
    # here (auto depends on the device, and a CPU run stays fp32 whatever the
    # config says), and the speech cache keys on it. Node deriving it a second
    # time is the one-fact-two-representations trap this project keeps paying for.
    print(
        f"READY reference={REFERENCE.stem} rate={SAMPLE_RATE} "
        f"precision={PRECISION} port={PORT}",
        flush=True,
    )
    server.serve_forever()
