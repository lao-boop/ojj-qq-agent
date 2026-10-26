"""本地 faster-whisper 转写服务（常驻，避免每次加载模型）。

启动：python scripts/asr_server.py [port]
接口：
  GET  /health              -> {"ok":true}
  POST /transcribe {"path": "..."} -> {"text": "...", "ms": 123}
"""
import json
import os
import subprocess
import shutil
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

os.environ.setdefault("HF_ENDPOINT", "https://huggingface.co")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from faster_whisper import WhisperModel  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(os.environ.get("QQBOT_DATA", os.path.join(ROOT, "data")), "models", "whisper")
MODEL_SIZE = os.environ.get("ASR_MODEL_SIZE", "small")
FFMPEG = os.environ.get(
    "FFMPEG_PATH",
    shutil.which("ffmpeg") or "ffmpeg",
)


def load_audio(path):
    """用 ffmpeg 解码成 16k 单声道 float32，绕开 PyAV 兼容问题。"""
    cmd = [
        FFMPEG, "-nostdin", "-threads", "0", "-i", path,
        "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le", "-ar", "16000", "-",
    ]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(out, np.int16).astype(np.float32) / 32768.0

print(f"[asr] loading {MODEL_SIZE} ...", flush=True)
t0 = time.time()
model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8", download_root=MODEL_DIR)
print(f"[asr] model ready in {time.time() - t0:.1f}s", flush=True)


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
            return self._send(200, {"ok": True, "model": MODEL_SIZE})
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
            segments, _info = model.transcribe(
                audio,
                language=None if lang == "auto" else lang,
                vad_filter=True,
                beam_size=3,
                temperature=0.0,
                condition_on_previous_text=False,
                initial_prompt="以下是中文对话。请忠实转写人名、项目名称、日期、数字和任务要求。",
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
