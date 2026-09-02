"""
Optional Whisper transcription for /voice-analyze.

faster-whisper is a heavy dependency (CTranslate2 + a model download), and the
Kavach helpline now uses browser speech-to-text, so it is NOT in
requirements.txt by default. Install it only if you need /voice-analyze:

    pip install faster-whisper

The model is loaded lazily on the first call, never at import time.
"""

MODEL_SIZE = "small"

_model = None
_import_error = None


def _get_model():
    global _model, _import_error
    if _model is not None:
        return _model
    try:
        from faster_whisper import WhisperModel  # heavy import, done lazily
    except Exception as exc:  # pragma: no cover
        _import_error = exc
        raise RuntimeError(
            "faster-whisper is not installed. Run `pip install faster-whisper` "
            "to enable /voice-analyze, or use the browser speech-to-text path."
        ) from exc
    _model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    return _model


def transcribe_audio(audio_path: str) -> dict:
    """Transcribe a Hindi/English disaster voice recording."""
    model = _get_model()

    segments, info = model.transcribe(
        audio_path,
        language="hi",
        task="transcribe",
        beam_size=5,
        best_of=5,
        temperature=0,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,
        initial_prompt=(
            "आपदा की स्थिति। "
            "घर में पानी घुस गया है। "
            "हम चार लोग हैं। "
            "दादी को सांस लेने में दिक्कत है। "
            "बाढ़, पानी, बचाव, राहत, चिकित्सा, "
            "घायल, फंसे हुए, खाना, पानी, दवा, "
            "शेल्टर, सड़क, रास्ता।"
        ),
    )

    text = " ".join(
        segment.text.strip() for segment in segments if segment.text.strip()
    ).strip()

    return {
        "text": text,
        "detected_language": info.language,
        "language_probability": round(info.language_probability, 4),
    }
