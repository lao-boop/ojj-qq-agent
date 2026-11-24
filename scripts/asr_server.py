"""小安本地语音转写服务（常驻，避免每次加载模型）。

启动：python scripts/asr_server.py [port]
接口：
  GET  /health              -> {"ok":true}
  POST /transcribe {"path": "..."} -> {"text": "...", "ms": 123}
"""
import json
import os
import subprocess
import sys
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from asr_consensus import choose_transcript, comparable, vote_spans

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from faster_whisper import WhisperModel  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT, "data", "models", "whisper")
MODEL_SIZE = os.environ.get("ASR_MODEL_SIZE", "small")
FFMPEG = os.environ.get(
    "FFMPEG_PATH",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "AstrBot", "backend", "python", "ffmpeg.exe"),
)


def load_audio(path):
    """用 ffmpeg 解码成 16k 单声道 float32，绕开 PyAV 兼容问题。"""
    cmd = [
        FFMPEG, "-nostdin", "-threads", "0", "-i", path,
        "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le", "-ar", "16000", "-",
    ]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(out, np.int16).astype(np.float32) / 32768.0

SENSE_DIR = os.path.join(ROOT, "data", "models", "sensevoice")
QWEN_DIR = os.path.join(ROOT, "data", "models", "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25")
FIRERED_DIR = os.path.join(ROOT, "data", "models", "sherpa-onnx-fire-red-asr2-zh_en-int8-2026-02-26")
def default_engine():
    selection = Path(ROOT, "data", "models", "mandarin-engine.txt")
    if not selection.is_file():
        return "sensevoice"
    mode = selection.read_text(encoding="utf-8-sig").strip()
    packages = {
        "qwen3": (QWEN_DIR, ("conv_frontend.onnx", "encoder.int8.onnx", "decoder.int8.onnx",
                             "tokenizer/vocab.json", "tokenizer/merges.txt", "tokenizer/tokenizer_config.json")),
        "firered2": (FIRERED_DIR, ("encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt")),
        "sensevoice": (SENSE_DIR, ("model.int8.onnx", "tokens.txt")),
    }
    if mode in ("firered-vote", "span-vote", "consensus", "context-rank"):
        needed = tuple(packages)
    elif mode in packages:
        needed = (mode,)
    else:
        return "sensevoice"
    if all(Path(packages[k][0], f).is_file() for k in needed for f in packages[k][1]):
        if mode == "context-rank":
            directory = Path(ROOT, "data/models")
            try:
                policy = json.loads((directory/"mandarin-selection.json").read_text(encoding="utf-8-sig"))
                if len(policy["weights"]) != 18 or not np.isfinite(policy["weights"]).all():
                    return "firered-vote"
                assets = ["bert-chinese-rerank/model_quantized.onnx","bert-chinese-rerank/tokenizer.json"]
                if policy["judge"]:
                    assets.append("Qwen2.5-3B-Instruct-GGUF/qwen2.5-3b-instruct-q4_k_m.gguf")
                if any(not (directory/asset).is_file() for asset in assets):
                    return "firered-vote"
            except (OSError, ValueError, TypeError, KeyError):
                return "firered-vote"
        return mode
    return "sensevoice"


ENGINE = os.environ.get("ASR_ENGINE", "auto")
if ENGINE == "auto":
    ENGINE = default_engine()
whisper_lock = threading.Lock()
whisper = None


def whisper_model():
    global whisper
    with whisper_lock:
        if whisper is None:
            whisper = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8", download_root=MODEL_DIR)
        return whisper


def load_mandarin():
    if ENGINE == "whisper":
        return None
    if not all(os.path.isfile(os.path.join(SENSE_DIR, f)) for f in ("model.int8.onnx", "tokens.txt")):
        return None
    try:
        from sherpa_onnx import OfflineRecognizer
        return OfflineRecognizer.from_sense_voice(
            model=os.path.join(SENSE_DIR, "model.int8.onnx"), tokens=os.path.join(SENSE_DIR, "tokens.txt"),
            language="zh", use_itn=ENGINE != "sensevoice-verbatim", num_threads=4, provider="cpu",
        )
    except (ImportError, RuntimeError, OSError) as exc:
        print(f"[asr] SenseVoice unavailable: {exc}", file=sys.stderr, flush=True)
        return None


decode_lock = threading.Lock()


def load_short_model(name):
    from sherpa_onnx import OfflineRecognizer
    if name == "qwen3":
        return OfflineRecognizer.from_qwen3_asr(
            conv_frontend=os.path.join(QWEN_DIR, "conv_frontend.onnx"),
            encoder=os.path.join(QWEN_DIR, "encoder.int8.onnx"),
            decoder=os.path.join(QWEN_DIR, "decoder.int8.onnx"),
            tokenizer=os.path.join(QWEN_DIR, "tokenizer"), num_threads=4,
        )
    if name == "firered2":
        return OfflineRecognizer.from_fire_red_asr(
            encoder=os.path.join(FIRERED_DIR, "encoder.int8.onnx"),
            decoder=os.path.join(FIRERED_DIR, "decoder.int8.onnx"),
            tokens=os.path.join(FIRERED_DIR, "tokens.txt"), num_threads=4,
        )
    raise ValueError(f"Unknown ASR model: {name}")


combined_modes = {"span-vote": "qwen3", "firered-vote": "firered2", "consensus": "qwen3",
                  "context-rank": "firered2"}
primary_engine = combined_modes.get(ENGINE, ENGINE)
has_short_model = primary_engine in ("qwen3", "firered2")
loaded_kind = primary_engine if has_short_model else None
short_model = load_short_model(loaded_kind) if loaded_kind else None
mandarin = load_mandarin() if not has_short_model or ENGINE in combined_modes else None
mandarin_loaded = mandarin is not None or not has_short_model
if not has_short_model and mandarin is None:
    whisper_model()
context_policy = None
word_selector = None
direct_selector = None
if ENGINE == "context-rank":
    context_policy = json.loads(Path(ROOT, "data/models/mandarin-selection.json").read_text(encoding="utf-8-sig"))
    if context_policy["acoustic"] and not context_policy["four"]:
        from asr_direct import configured_policy, DirectSelector
        try:
            policy = configured_policy()
            if policy is not None:
                direct_selector = DirectSelector(policy)
        except (OSError, ValueError, KeyError, TypeError) as err:
            print(f"[asr] supplemental selection unavailable: {err}", file=sys.stderr, flush=True)


def sensevoice():
    global mandarin, mandarin_loaded
    if not mandarin_loaded:
        mandarin = load_mandarin()
        mandarin_loaded = True
    return mandarin


def decode(recognizer, audio, verbatim=False):
    stream = recognizer.create_stream()
    if verbatim:
        stream.set_option("use_itn", "0")
    stream.accept_waveform(16000, audio)
    recognizer.decode_stream(stream)
    return stream.result.text.strip()


def short_transcript(kind, audio):
    # Only one large decoder is resident at a time on this 16 GB host.
    global loaded_kind, short_model
    if loaded_kind != kind or short_model is None:
        short_model = None
        loaded_kind = None
        short_model = load_short_model(kind)
        loaded_kind = kind
    return decode(short_model, audio)


def release_short_decoder():
    global loaded_kind, short_model
    loaded_kind = None
    short_model = None


def transcribe_mandarin(audio, *, questions=None, readings=None, primary=None):
    global word_selector, direct_selector
    from faster_whisper.vad import get_speech_timestamps
    with decode_lock:
        short = has_short_model and len(audio) <= 30 * 16000
        if not short and sensevoice() is None:
            return None
        if not len(audio) or not get_speech_timestamps(audio):
            return ""
        if not short:
            return decode(mandarin, audio)
        if ENGINE not in combined_modes or mandarin is None:
            return short_transcript(primary_engine, audio)
        other = "firered2" if primary_engine == "qwen3" else "qwen3"
        # Reuse the decoder already in memory before swapping weights.
        alternate = short_transcript(other, audio) if loaded_kind == other else None
        first = short_transcript(primary_engine, audio)
        fast = decode(mandarin, audio)
        if ENGINE != "context-rank" and comparable(first) and comparable(first) == comparable(fast):
            return first
        if alternate is None:
            alternate = short_transcript(other, audio)
        if ENGINE == "context-rank":
            from asr_context import MandarinWordSelector, Surface
            texts = [first, alternate, fast]
            if direct_selector is not None:
                if word_selector is None:
                    word_selector = MandarinWordSelector(context_policy)
                try:
                    text, fields = direct_selector.resolve(audio,texts,word_selector,release_decoder=release_short_decoder,
                                                          readings_out=readings, primary_out=primary)
                    if questions is not None:
                        questions.extend(fields)
                    return text
                except (OSError, RuntimeError, MemoryError) as err:
                    print(f"[asr] falling back to original selector: {err}",file=sys.stderr,flush=True)
                    direct_selector = None
            if Surface(first).tokens == Surface(alternate).tokens == Surface(fast).tokens:
                return first
            if context_policy["four"]:
                texts.append(decode(mandarin, audio, verbatim=True))
            if word_selector is None:
                word_selector = MandarinWordSelector(context_policy)
            evidence = [] if questions is not None else None
            text = word_selector.select(audio, texts, evidence)
            if questions is not None:
                from asr_clarification import clarification_fields
                questions.extend(clarification_fields(text, texts, evidence))
            return text
        combine = choose_transcript if ENGINE == "consensus" else vote_spans
        return combine(first, alternate, fast)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[asr] " + (fmt % args) + "\n")

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            model = MODEL_SIZE
            if mandarin is not None:
                model = "sensevoice-verbatim" if ENGINE == "sensevoice-verbatim" else "sensevoice-int8"
            if has_short_model:
                model = ENGINE
            status = {"ok": True, "model": model}
            if direct_selector is not None:
                status["supplementaryRecognizers"] = direct_selector.policy["readers"]
                status["candidateReview"] = bool(direct_selector.policy.get("candidate_review"))
                status["semanticReview"] = bool(status["candidateReview"] and direct_selector.policy.get("semantic_review"))
            return self._send(200, status)
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
            path = req.get("path")
            lang = str(req.get("language") or "zh")
            if not path or not os.path.exists(path):
                return self._send(400, {"error": "file not found"})
            started = time.time()
            audio = load_audio(path)
            questions = []
            readings = []
            primary = []
            text = transcribe_mandarin(audio, questions=questions, readings=readings, primary=primary) if lang == "zh" else None
            if text is not None:
                return self._send(200, {"text": text, "lang": lang, "questions": questions, "readings": readings, "primary": primary,
                                        "ms": int((time.time() - started) * 1000)})
            segments, _info = whisper_model().transcribe(
                audio,
                language=None if lang == "auto" else lang,
                vad_filter=True,
                beam_size=3,
                temperature=0.0,
                condition_on_previous_text=False,
                initial_prompt="以下是普通话或粤语对话，可能提到小安、汽修配件、刹车片、空气滤芯、火花塞、车型、报价。",
                hotwords="小安 刹车片 空气滤芯 火花塞 车型 报价",
            )
            text = "".join(seg.text for seg in segments).replace(" ", "").strip()
            return self._send(200, {"text": text, "lang": lang, "ms": int((time.time() - started) * 1000)})
        except Exception as exc:  # noqa: BLE001
            return self._send(500, {"error": str(exc)})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[asr] listening 127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
