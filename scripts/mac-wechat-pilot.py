#!/usr/bin/env python3
"""Single-peer, explicit-command Mac pilot. Keep the selected chat visible."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mac_send_check", ROOT / "scripts/mac-wechat-send-check.py")
ui_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui_module)
START = re.compile(r"^(汇报|汇总|详情)\s*([A-Z][0-9]{2,6})(?![0-9])", re.I)
COMMAND = re.compile(r"^(汇报|汇总|详情)\s*([A-Z][0-9]{2,6})(?![0-9])\s*[:：]?\s*(.*?)\s*#END$", re.S | re.I)


def parse_requests(rows, input_top):
    """Require a complete visible envelope; never interpret arbitrary OCR as a command."""
    result, collected, previous = [], [], None
    for row in sorted(rows, key=lambda r: (-r["y"], r["x"])):
        if not (row["x"] > .2 and input_top < row["y"] < .84):
            continue
        text = row["text"].strip()
        if row.get("direction") != "incoming" or row.get("confidence", 0) < .75:
            collected, previous = [], None
            continue
        if START.match(text):
            collected, previous = [], None
        elif not collected:
            continue
        if previous and previous["y"] - row["y"] > max(.045, previous["h"] * 2.8):
            collected = []
            continue
        collected.append(row)
        previous = row
        joined = " ".join(r["text"].strip() for r in collected).replace("＃", "#")
        if len(joined) > 2200 or len(collected) > 16:
            collected = []
            continue
        match = COMMAND.fullmatch(joined)
        if not match:
            continue
        action, request_id, body = match.groups()
        request_id = request_id.upper()
        body = body.strip()
        if re.search(r"(?:汇报|汇总|详情)\s*[A-Z][0-9]{2,6}", body, re.I):
            collected, previous = [], None
            continue
        if ((action == "汇报" and body and len(body) <= 2000)
                or (action == "汇总" and (not body or re.fullmatch(r"第[1-9][0-9]{0,4}页", body)))
                or (action == "详情" and re.fullmatch(r"R[0-9]{6,}", body))):
            result.append({"requestId": request_id, "action": {"汇报": "report", "汇总": "summary", "详情": "detail"}[action],
                           "text": body, "rows": list(collected)})
        collected, previous = [], None
    return result


def fingerprint(request):
    payload = {key: request[key] for key in ("requestId", "action", "text")}
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class PilotState:
    def __init__(self, directory, peer):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = open(self.directory / "pilot.lock", "a+")
        os.chmod(self.directory / "pilot.lock", 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            raise RuntimeError("该试点已在运行，请先停止另一个终端里的进程")
        scope_file = self.directory / "scope.json"
        scope = {"mode": "single-peer-pilot-v1", "peer": peer}
        if scope_file.exists():
            if json.loads(scope_file.read_text()) != scope:
                self.close()
                raise RuntimeError("数据目录不是该联系人的独立试点目录")
        else:
            if (self.directory / "reports.json").exists():
                self.close()
                raise RuntimeError("拒绝接管已有汇报文件；请选择独立试点目录")
            with os.fdopen(os.open(scope_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as out:
                json.dump(scope, out, ensure_ascii=False)
                out.flush(); os.fsync(out.fileno())
        self.db = sqlite3.connect(self.directory / "pilot.sqlite")
        os.chmod(self.directory / "pilot.sqlite", 0o600)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, fingerprint TEXT, state TEXT, evidence TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS sends(id TEXT PRIMARY KEY, state TEXT, created REAL)")
        self.db.execute("UPDATE requests SET state='unknown' WHERE state='processing'")
        self.db.execute("UPDATE sends SET state='unknown' WHERE state='sending'")
        self.db.commit()

    def close(self):
        if getattr(self, "db", None): self.db.close()
        if getattr(self, "lock", None): self.lock.close()

    def seen(self, request):
        row = self.db.execute("SELECT fingerprint,state FROM requests WHERE id=?", (request["requestId"],)).fetchone()
        return row

    def begin(self, request, evidence):
        self.db.execute("INSERT INTO requests VALUES(?,?,?,?)", (request["requestId"], fingerprint(request), "processing", evidence))
        self.db.commit()

    def finish(self, request_id, state):
        self.db.execute("UPDATE requests SET state=? WHERE id=?", (state, request_id))
        self.db.commit()

    def send_state(self, send_id, state):
        self.db.execute("INSERT INTO sends VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state", (send_id, state, time.time()))
        self.db.commit()


class Reader:
    def __init__(self):
        from PIL import Image, ImageStat
        self.Image, self.ImageStat = Image, ImageStat
        self.image, self.rows = None, []

    def frame(self, filename, rows):
        if self.image is not None: self.image.close()
        with self.Image.open(filename) as source:
            self.image = source.convert("RGB")
        width, height = self.image.size
        self.rows = []
        for row in rows:
            r = dict(row)
            left, top = max(0, int(r["x"] * width)), max(0, int((1-r["y"]-r["h"]) * height))
            right, bottom = min(width, int((r["x"]+r["w"]) * width)), min(height, int((1-r["y"]) * height))
            r["direction"] = "unknown"
            if right > left and bottom > top:
                with self.image.crop((left, top, right, bottom)) as crop:
                    red, green, blue = self.ImageStat.Stat(crop).median[:3]
                if green > red + 18 and green > blue + 18 and green > 100:
                    r["direction"] = "self"
                elif min(red, green, blue) >= 210 and max(red, green, blue) - min(red, green, blue) <= 25:
                    r["direction"] = "incoming"
            self.rows.append(r)

    def evidence(self, directory, rows, identifier):
        width, height = self.image.size
        left = max(0, int(min(r["x"] for r in rows) * width) - 6)
        right = min(width, int(max(r["x"]+r["w"] for r in rows) * width) + 6)
        top = max(0, int((1-max(r["y"]+r["h"] for r in rows)) * height) - 6)
        bottom = min(height, int((1-min(r["y"] for r in rows)) * height) + 6)
        folder = Path(directory) / "evidence"
        folder.mkdir(exist_ok=True, mode=0o700)
        with self.image.crop((left, top, right, bottom)) as crop:
            with os.fdopen(os.open(folder / f"{identifier}.png", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as out:
                crop.save(out, format="PNG")
                out.flush(); os.fsync(out.fileno())


def calibrate(ui, reader, peer, state):
    """Use the already-tested send path to locate the input row and self bubble."""
    marker = "B" + secrets.token_hex(5).upper()
    positions = []
    def frame(filename, rows):
        reader.frame(filename, rows)
        for row in reader.rows:
            if marker in ui_module.compact(row["text"]): positions.append(dict(row))
    ui.on_frame = frame
    state.send_state(marker, "sending")
    code = ui_module.send_once(ui, peer, "单联系人试运行正在校准。请等终端显示 READY 后，按终端示例提交汇报。", marker)
    state.send_state(marker, "visible" if code == 0 else "blocked" if code == 2 else "unknown")
    ui.on_frame = reader.frame
    if code:
        raise RuntimeError("启动消息未确认；查看聊天后再决定是否重启")
    inputs = [r for r in positions if 0 < r["y"] < .35]
    outgoing = [r for r in reader.rows if marker in ui_module.compact(r["text"]) and r["direction"] == "self"]
    if not inputs or not outgoing:
        raise RuntimeError("未确认输入区或绿色发送气泡；当前只支持可识别的浅色聊天界面")
    input_row = inputs[0]
    input_top = input_row["y"] + input_row["h"] + .025
    if not .08 < input_top < .45 or outgoing[0]["y"] <= input_top:
        raise RuntimeError("消息区边界不明确，未启动持续采集")
    return input_top


class Bridge:
    def __init__(self, node, state, peer, ui=None):
        self.state, self.peer, self.ui = state, peer, ui
        self.messages = queue.Queue()
        self.process = subprocess.Popen([node, str(ROOT / "scripts/mac-pilot-bridge.mjs"), str(state.directory), peer],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        text=True, encoding="utf-8", bufsize=1)
        def read():
            try:
                for line in self.process.stdout:
                    if not line.strip(): continue
                    message = json.loads(line)
                    if not isinstance(message, dict):
                        self.messages.put({"type": "broken", "reason": "JSON_FRAME"})
                        return
                    self.messages.put(message)
            except (UnicodeError, json.JSONDecodeError):
                self.messages.put({"type": "broken", "reason": "JSON_DECODE"})
            except Exception:
                self.messages.put({"type": "broken", "reason": "PIPE_READ"})
            finally:
                self.messages.put({"type": "closed"})
        self.thread = threading.Thread(target=read, daemon=True)
        self.thread.start()
        try:
            try: ready = self.messages.get(timeout=10)
            except queue.Empty:
                raise RuntimeError("SERVICE_START_TIMEOUT：汇报服务 10 秒内没有返回启动结果") from None
            if ready.get("type") == "closed":
                self.process.wait(timeout=3)
                raise RuntimeError(f"SERVICE_EXIT：汇报服务在启动前退出，退出码 {self.process.returncode}")
            if ready.get("type") == "broken":
                raise RuntimeError(f"SERVICE_PROTOCOL：汇报服务输出无法解析（{ready['reason']}）")
            if ready.get("type") != "ready" or type(ready.get("modelEnabled")) is not bool:
                raise RuntimeError("SERVICE_HANDSHAKE：汇报服务没有返回有效的启动确认")
        except Exception:
            self.close()
            raise
        print("模型摘录：" + ("已启用本机配置的外部模型服务" if ready["modelEnabled"] else "未启用，使用本地文字摘录"), flush=True)

    def write(self, message):
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def call(self, request):
        rpc_id = uuid.uuid4().hex
        self.write({"type": "request", "id": rpc_id, **request})
        deadline, send_failed = time.monotonic() + 100, False
        while time.monotonic() < deadline:
            try: message = self.messages.get(timeout=max(.1, deadline-time.monotonic()))
            except queue.Empty:
                raise RuntimeError("SERVICE_REQUEST_TIMEOUT：汇报服务处理超时") from None
            if message.get("type") == "send":
                if self.ui is None:
                    raise RuntimeError("SERVICE_CHECK_SEND_BLOCKED：服务检查期间禁止发送微信消息")
                marker = "B" + secrets.token_hex(5).upper()
                self.state.send_state(message["id"], "sending")
                code = ui_module.send_once(self.ui, self.peer, str(message["text"]), marker)
                self.state.send_state(message["id"], "visible" if code == 0 else "blocked" if code == 2 else "unknown")
                self.write({"type": "send-result", "id": message["id"], "visible": code == 0})
                send_failed |= code != 0
            elif message.get("type") == "complete" and message.get("id") == rpc_id:
                if send_failed or not message.get("ok"):
                    raise RuntimeError("本次处理或发送未确认；程序停止，已有记录保留，不自动重试")
                return message["status"]
            else:
                raise RuntimeError("SERVICE_CONNECTION：汇报服务连接中断或输出异常")
        raise RuntimeError("汇报服务处理超时")

    def close(self):
        if getattr(self, "process", None):
            try:
                self.process.stdin.close()
                self.process.wait(timeout=3)
            except Exception:
                self.process.terminate()
                try: self.process.wait(timeout=3)
                except subprocess.TimeoutExpired: self.process.kill(); self.process.wait()
            self.thread.join(timeout=1)
            self.process.stdout.close()


def node_path():
    candidates = [shutil.which("node"), "/opt/homebrew/opt/node@24/bin/node", "/usr/local/opt/node@24/bin/node"]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            version = subprocess.check_output([candidate, "--version"], text=True).strip()
            if int(version.lstrip("v").split(".")[0]) >= 20: return candidate
    raise RuntimeError("未找到 Node.js 20+，请检查 Node.js 24 安装")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--peer", required=True, help="用户已核实的唯一试点联系人备注")
    parser.add_argument("--data-root", type=Path, default=Path.home()/"wechat-assistant"/"pilot-data")
    parser.add_argument("--check-service", action="store_true", help="只检查本地汇报服务，不截图、不操作微信")
    args = parser.parse_args()
    if sys.platform != "darwin" and not args.check_service: raise RuntimeError("需要在你的 Mac 上运行")
    if not args.peer.strip(): raise RuntimeError("试点联系人不能为空")
    os.umask(0o077)
    directory = args.data_root / hashlib.sha256(args.peer.encode()).hexdigest()[:16]
    state = PilotState(directory, args.peer)
    bridge, reader = None, None
    try:
        node = node_path()
        print(f"Node：{node}", flush=True)
        # Start and check Node before loading Cocoa/Vision or sending calibration.
        bridge = Bridge(node, state, args.peer)
        status = bridge.call({"action": "status"})
        if args.check_service:
            print(f"SERVICE_OK：汇报服务已启动并完成通信检查；已有 {status['count']} 条汇报。没有截图或发送微信消息。", flush=True)
            return
        reader = Reader()
        ui = ui_module.WechatUI(args.peer)
        bridge.ui = ui
        input_top = calibrate(ui, reader, args.peer, state)
        print("READY：只处理当前试点联系人，保持该聊天可见、输入框空白。Ctrl+C 停止。", flush=True)
        print("示例：汇报 A01 项目A已经交付 #END\n汇总 Q01 #END\n详情 Q02 R000001 #END", flush=True)
        print(f"记录保存在：{directory}\n每个新请求请换编号；相同编号不会再次处理。每五分钟汇总未通知记录。", flush=True)
        previous, warned = {}, set()
        next_flush = time.monotonic() + 300
        while True:
            ui.snapshot()
            requests = parse_requests(reader.rows, input_top)
            grouped = {}
            for request in requests:
                grouped.setdefault(request["requestId"], []).append(request)
            conflicts = {rid for rid, group in grouped.items() if len({fingerprint(r) for r in group}) > 1}
            for rid in conflicts - warned:
                print(f"同一画面中编号 {rid} 对应不同内容，未处理；请使用新编号提交。", flush=True)
                warned.add(rid)
            requests = [group[0] for rid, group in grouped.items() if rid not in conflicts]
            current = {r["requestId"]: fingerprint(r) for r in requests}
            # Process only one request per frame: sending changes the screen and invalidates the remaining coordinates.
            processed = False
            for request in requests:
                seen = state.seen(request)
                if seen:
                    if (seen[0] != fingerprint(request) or seen[1] != "done") and request["requestId"] not in warned:
                        print(f"编号 {request['requestId']} 已存在或状态未确认，未重复处理；请先查询已有记录。", flush=True)
                        warned.add(request["requestId"])
                    continue
                if previous.get(request["requestId"]) != current[request["requestId"]]: continue
                observation = uuid.uuid4().hex
                reader.evidence(directory, request["rows"], observation)
                state.begin(request, observation)
                try:
                    status = bridge.call({key: request[key] for key in ("requestId", "action", "text")} | {"observationId": observation})
                    state.finish(request["requestId"], "done")
                except BaseException:
                    state.finish(request["requestId"], "unknown")
                    raise
                print(f"已处理 {request['requestId']}；共 {status['count']} 条汇报，待汇总 {status['pending']} 条。", flush=True)
                processed = True
                break
            previous = {} if processed else current
            if time.monotonic() >= next_flush:
                bridge.call({"action": "flush"})
                previous = {}
                next_flush = time.monotonic() + 300
            time.sleep(3)
    finally:
        if bridge: bridge.close()
        if reader and reader.image is not None: reader.image.close()
        state.close()


if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: print("已停止；已有记录保留。")
    except Exception as error:
        print("已停止：" + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
