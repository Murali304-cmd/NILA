"""
NILA - Voice (optional, local)
------------------------------
  STT: faster-whisper (small model)  -> spoken audio to text
  TTS: Piper                        -> text to spoken audio (wav)

Both are OPTIONAL and gracefully reported if not installed. Without them,
the web app can still use the browser's built-in speech (speechSynthesis
for output). NILA works fully without voice.
"""

import io
import os
import subprocess
import tempfile

from pydantic import BaseModel

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STT_MODEL = os.environ.get("STT_MODEL", "small")          # faster-whisper size
PIPER_BIN = os.environ.get("PIPER_BIN", "piper")          # piper executable
PIPER_MODEL = os.environ.get("PIPER_MODEL", "")           # path to .onnx voice
PIPER_CONFIG = os.environ.get("PIPER_CONFIG", "")         # path to .onnx.json


# ---------------------------------------------------------------------------
# Speech-to-Text (Whisper / faster-whisper)
# ---------------------------------------------------------------------------

def stt_available():
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def transcribe(audio_bytes, content_type="audio/wav"):
    """Turn audio bytes into text using faster-whisper (fully local)."""
    if not stt_available():
        raise RuntimeError(
            "Voice input is not installed. Run:  pip install faster-whisper  "
            "(then it downloads a small model once). Voice stays optional — "
            "you can keep typing."
        )

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise RuntimeError("faster-whisper is not installed.")

    # Model is loaded once and kept for the process.
    if not getattr(transcribe, "_model", None):
        transcribe._model = WhisperModel(STT_MODEL, device="cpu",
                                         compute_type="int8")

    suffix = ".wav"
    if "webm" in content_type:
        suffix = ".webm"
    elif "ogg" in content_type:
        suffix = ".ogg"
    elif "mp3" in content_type:
        suffix = ".mp3"

    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp_path = tmp.name
    try:
        tmp.write(audio_bytes)
        tmp.flush()
        tmp.close()
        segments, _info = transcribe._model.transcribe(tmp_path, language=None)
        text = " ".join(seg.text.strip() for seg in segments).strip()
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    if not text:
        raise ValueError("No speech detected.")
    return text


# ---------------------------------------------------------------------------
# Text-to-Speech (Piper)
# ---------------------------------------------------------------------------

def tts_available():
    if not PIPER_MODEL:
        return False
    return os.path.exists(PIPER_MODEL)


def synthesize(text):
    """Return wav bytes for the given text using Piper (fully local)."""
    if not tts_available():
        raise RuntimeError(
            "Voice output is not installed. Download a Piper voice model, "
            "then set PIPER_MODEL (and PIPER_CONFIG) in your .env file."
        )

    cmd = [PIPER_BIN, "-m", PIPER_MODEL]
    if PIPER_CONFIG:
        cmd += ["-c", PIPER_CONFIG]

    proc = subprocess.run(cmd, input=text.encode("utf-8"),
                          capture_output=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(f"Piper failed: {proc.stderr.decode('utf-8', 'ignore')[:200]}")
    return proc.stdout


def tts_status():
    return {
        "stt_available": stt_available(),
        "stt_model": STT_MODEL,
        "tts_available": tts_available(),
        "tts_model": os.path.basename(PIPER_MODEL) if PIPER_MODEL else "",
    }


# Re-export for FastAPI type hints.
class TTSRequest(BaseModel):
    text: str


class TTSResponse(BaseModel):
    status: str
    detail: str
