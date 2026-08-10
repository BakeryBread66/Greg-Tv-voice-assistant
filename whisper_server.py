"""
Greg's ears: a small local speech-to-text service.

Node starts this automatically and talks to it over localhost. It keeps the
Whisper model resident so each transcription is fast; loading the model per
request would cost about a second every time.

Nothing leaves this machine.
"""

import ctypes
import io
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_NAME = os.environ.get("GREG_WHISPER_MODEL", "base.en")
DEVICE_PREF = os.environ.get("GREG_WHISPER_DEVICE", "auto")
PORT = int(os.environ.get("GREG_WHISPER_PORT", "4748"))


def preload_cuda():
    """
    Make the CUDA libraries from the nvidia-* pip packages loadable.

    Adding the directories to the DLL search path is not enough on Windows —
    ctranslate2's static imports don't search them, so cuBLAS fails to resolve.
    Loading each library into the process first does work. Dependencies first:
    cuBLAS needs the CUDA runtime.
    """
    site = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
    if not os.path.isdir(site):
        return 0

    for package in ("cuda_runtime", "cublas", "cudnn", "cuda_nvrtc"):
        directory = os.path.join(site, package, "bin")
        if os.path.isdir(directory):
            try:
                os.add_dll_directory(directory)
            except OSError:
                pass

    libraries = [
        ("cuda_runtime", "cudart64_12.dll"),
        ("cublas", "cublasLt64_12.dll"),
        ("cublas", "cublas64_12.dll"),
        ("cudnn", "cudnn64_9.dll"),
        ("cudnn", "cudnn_graph64_9.dll"),
        ("cudnn", "cudnn_ops64_9.dll"),
        ("cudnn", "cudnn_engines_precompiled64_9.dll"),
        ("cudnn", "cudnn_engines_runtime_compiled64_9.dll"),
        ("cudnn", "cudnn_heuristic64_9.dll"),
    ]

    loaded = 0
    for package, dll in libraries:
        path = os.path.join(site, package, "bin", dll)
        if os.path.exists(path):
            try:
                ctypes.WinDLL(path)
                loaded += 1
            except OSError:
                pass
    return loaded


if sys.platform == "win32":
    preload_cuda()

from faster_whisper import WhisperModel  # noqa: E402  (must follow the preload)


def build_model():
    """Prefer the GPU, fall back to the CPU rather than failing outright."""
    attempts = []
    if DEVICE_PREF in ("auto", "cuda"):
        attempts.append(("cuda", "float16"))
    if DEVICE_PREF in ("auto", "cpu"):
        attempts.append(("cpu", "int8"))

    errors = []
    for device, compute in attempts:
        try:
            model = WhisperModel(MODEL_NAME, device=device, compute_type=compute)
            return model, device
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{device}: {exc}")

    raise RuntimeError("could not start Whisper -> " + " | ".join(errors))


MODEL, DEVICE = build_model()


def transcribe(audio_bytes):
    segments, _info = MODEL.transcribe(
        io.BytesIO(audio_bytes),
        language="en",
        beam_size=1,
        # Whisper invents text when given silence; the VAD filter suppresses most
        # of it, and not conditioning on previous text stops it looping.
        vad_filter=True,
        condition_on_previous_text=False,
    )
    return " ".join(segment.text for segment in segments).strip()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "device": DEVICE, "model": MODEL_NAME})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self._send(404, {"error": "not found"})

        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return self._send(400, {"error": "no audio"})

        audio = self.rfile.read(length)
        started = time.time()
        try:
            text = transcribe(audio)
        except Exception as exc:  # noqa: BLE001
            return self._send(500, {"error": f"{type(exc).__name__}: {exc}"})

        self._send(200, {"text": text, "ms": int((time.time() - started) * 1000), "device": DEVICE})

    def log_message(self, *args):
        pass  # Node owns the console


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    # Node watches stdout for this line before sending any audio.
    print(f"READY device={DEVICE} model={MODEL_NAME} port={PORT}", flush=True)
    server.serve_forever()
