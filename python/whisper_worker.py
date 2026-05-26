"""
whisper_worker.py — faster-whisper subprocess worker.

Reads raw 16-bit PCM @ 16kHz mono from stdin in fixed-size chunks,
transcribes each chunk, and writes a single text line per chunk to stdout.
"""

import os
import sys

try:
    from faster_whisper import WhisperModel
except ImportError:
    sys.stderr.write("faster-whisper is not installed. Run: pip install faster-whisper\n")
    sys.stderr.flush()
    sys.exit(1)

import numpy as np

SAMPLE_RATE = 16000
CHUNK_SECONDS = int(os.environ.get("WHISPER_CHUNK_SECONDS", "8"))
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
BYTES_PER_CHUNK = SAMPLE_RATE * CHUNK_SECONDS * 2  # 16-bit = 2 bytes


def main() -> None:
    sys.stderr.write(f"Loading faster-whisper model='{MODEL_SIZE}' (first run downloads ~500MB)…\n")
    sys.stderr.flush()

    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")

    sys.stderr.write("Model ready. Listening for PCM chunks on stdin.\n")
    sys.stderr.flush()

    stdin = sys.stdin.buffer
    while True:
        raw = b""
        # read until we have a full chunk or stdin closes
        while len(raw) < BYTES_PER_CHUNK:
            piece = stdin.read(BYTES_PER_CHUNK - len(raw))
            if not piece:
                return
            raw += piece

        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        try:
            segments, _ = model.transcribe(audio, language="en", vad_filter=True)
            text = " ".join(s.text for s in segments).strip()
        except Exception as e:
            sys.stderr.write(f"transcribe error: {e}\n")
            sys.stderr.flush()
            text = ""

        if text:
            sys.stdout.write(text + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
