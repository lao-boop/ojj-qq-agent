"""Configure this machine only. Secrets are entered locally and never printed."""
import getpass
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import time


def ask(label, default=""):
    return input(f"{label}" + (f" [{default}]" if default else "") + ": ").strip() or default


def secret(label, current=""):
    return getpass.getpass(label + ("（回车保留现有值）" if current else "（可留空跳过）") + ": ").strip() or current


def configure(cfg):
    cfg.setdefault("chat", {}).setdefault("agents", {})["enabled"] = True
    python = str(Path(sys.executable).absolute())
    for section in ("files", "office", "tts"):
        cfg.setdefault(section, {})["pythonPath"] = python
    cfg["office"]["model"] = cfg.get("llm", {}).get("model", "deepseek-chat")
    ffmpeg = shutil.which("ffmpeg") or ""
    cfg.setdefault("media", {})["ffmpegPath"] = ffmpeg
    local = cfg.setdefault("asr", {}).setdefault("local", {})
    ready = bool(ffmpeg and importlib.util.find_spec("faster_whisper") and importlib.util.find_spec("pilk"))
    cfg["asr"].update(enabled=ready, maxSeconds=300)
    local.update(enabled=ready, pythonPath=python, url="http://127.0.0.1:8090", port=8090, model="small")
    if not ready:
        print("本地语音识别尚缺 ffmpeg、faster-whisper 或 pilk，本次保持关闭；装好后可重跑向导。")

    print("\nMiniMax 语音输出（国内站）")
    tts = cfg["tts"]
    mm = tts.setdefault("minimax", {})
    mm["apiKey"] = secret("MiniMax API Key", mm.get("apiKey", ""))
    if mm["apiKey"]:
        mm["baseUrl"] = ask("MiniMax 接口根地址", mm.get("baseUrl") or "https://api.minimaxi.com")
        mm["model"] = ask("语音模型（以账号可用模型为准）", mm.get("model") or "speech-02-hd")
        mm["voiceId"] = ask("音色 voice_id", mm.get("voiceId") or "male-qn-qingse")
        mm.update(speed=1, volume=1, pitch=0, timeoutMs=60000)
        tts.update(enabled=True, provider="minimax", maxChars=120)
    else:
        print("未提供 MiniMax 密钥，保留原有语音输出设置。")

    print("\n视觉识别需要支持 image_url 的模型。网页上传能力不能代替 API 能力。")
    vision = cfg.setdefault("vision", {})
    url = ask("视觉 API baseUrl（没有可用视觉服务时直接回车）", vision.get("baseUrl", ""))
    if url:
        model = ask("视觉模型名称", vision.get("model", ""))
        key = secret("视觉 API Key", vision.get("apiKey", ""))
        vision.update(enabled=bool(model and key), baseUrl=url.rstrip("/"), model=model, apiKey=key, timeoutMs=90000)
    else:
        vision["enabled"] = False

    print("\nMac + NapCat Docker 附件共享目录")
    shared = Path.home() / "qq-agent-dev" / "napcat" / "data" / "qq"
    raw = ask("宿主机 QQ 数据目录（采用前面 compose 配置时保持默认）", str(shared))
    folder = Path(raw).expanduser().resolve()
    if folder.is_dir():
        mappings = cfg["files"].setdefault("pathMappings", [])
        mappings[:] = [m for m in mappings if m.get("remote") != "/app/.config/QQ"]
        mappings.append({"remote": "/app/.config/QQ", "local": str(folder)})
    else:
        print("共享目录不存在，未写入路径映射；URL 可下载的附件仍可使用。")

    print("\n画图、原创歌曲和变声使用独立服务，本次保留它们的现有设置。")
    return cfg


def main():
    root = Path(__file__).resolve().parent.parent
    target = Path(os.environ.get("QQBOT_CONFIG", root / "config.json"))
    cfg = json.loads(target.read_text(encoding="utf-8"))
    cfg = configure(cfg)
    # Store backup outside the repository, including its private credentials.
    backups = Path.home() / ".qq-agent-backups"
    backups.mkdir(mode=0o700, exist_ok=True)
    backup = backups / f"config-{time.time_ns()}.json"
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        out.write(target.read_text(encoding="utf-8"))
    temp = target.with_name(f"{target.name}.{os.getpid()}.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        json.dump(cfg, out, ensure_ascii=False, indent=2)
        out.write("\n")
    os.replace(temp, target)
    print(f"\n本地配置已保存：{target}；原配置备份：{backup}")
    print("这是配置完成，尚未验证服务连通性。重启机器人后逐项测试；密钥没有上传。")


if __name__ == "__main__":
    main()
