#!/usr/bin/env python3
"""One explicit, bounded send test to the user-selected conversation.

No chat search, background listener, remote API, or automatic resend. A visible
outgoing bubble is local UI evidence, never a recipient delivery/read receipt.
"""
import argparse
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


def compact(text):
    return "".join(text.split())


class WechatUI:
    def __init__(self, target):
        if sys.platform != "darwin":
            raise RuntimeError("需要在 Mac 上运行")
        import AppKit
        import Quartz
        import Vision
        from Foundation import NSURL
        self.A, self.Q, self.V, self.URL = AppKit, Quartz, Vision, NSURL
        self.target = target
        self.identity = None
        self.on_frame = None

    def snapshot(self):
        Q, V = self.Q, self.V
        windows = Q.CGWindowListCopyWindowInfo(
            Q.kCGWindowListOptionOnScreenOnly | Q.kCGWindowListExcludeDesktopElements, 0
        ) or []
        windows = [w for w in windows if w.get("kCGWindowOwnerName") in ("WeChat", "Weixin", "微信")
                   and w.get("kCGWindowLayer") == 0
                   and w.get("kCGWindowBounds", {}).get("Width", 0) >= 500
                   and w.get("kCGWindowBounds", {}).get("Height", 0) >= 350]
        if len(windows) != 1:
            raise RuntimeError("请只保留一个微信主窗口，关闭设置和独立聊天窗口")
        window = windows[0]
        identity = (window["kCGWindowNumber"], window["kCGWindowOwnerPID"], dict(window["kCGWindowBounds"]))
        if self.identity is not None and identity != self.identity:
            raise RuntimeError("微信窗口或位置发生变化，已停止操作")
        self.identity = identity
        with tempfile.TemporaryDirectory(prefix="wechat-send-check-") as folder:
            image = Path(folder) / "window.png"
            result = subprocess.run(["/usr/sbin/screencapture", "-x", "-o", "-l", str(identity[0]), str(image)],
                                    capture_output=True, timeout=15)
            if result.returncode or not image.is_file():
                raise RuntimeError("微信窗口截图失败")
            request = V.VNRecognizeTextRequest.alloc().init()
            request.setRecognitionLanguages_(["zh-Hans", "en-US"])
            request.setRecognitionLevel_(V.VNRequestTextRecognitionLevelAccurate)
            handler = V.VNImageRequestHandler.alloc().initWithURL_options_(self.URL.fileURLWithPath_(str(image)), None)
            success, _ = handler.performRequests_error_([request], None)
            if not success:
                raise RuntimeError("文字识别失败")
            rows = []
            details = []
            for observation in request.results() or []:
                candidates = observation.topCandidates_(1)
                if candidates:
                    box = observation.boundingBox()
                    rows.append((compact(str(candidates[0].string())), float(box.origin.x), float(box.origin.y)))
                    details.append({"text": str(candidates[0].string()), "x": float(box.origin.x),
                                    "y": float(box.origin.y), "w": float(box.size.width),
                                    "h": float(box.size.height), "confidence": float(candidates[0].confidence())})
            title_hits = [r for r in rows if r[1] > .2 and r[2] > .84 and r[0] == compact(self.target)]
            if len(title_hits) != 1:
                raise RuntimeError("未唯一识别目标聊天标题，请手动打开指定联系人的聊天")
            if self.on_frame:
                self.on_frame(image, details)
        return rows

    def foreground(self):
        app = self.A.NSWorkspace.sharedWorkspace().frontmostApplication()
        if not app or app.processIdentifier() != self.identity[1]:
            raise RuntimeError("微信不是当前前台应用，已停止输入")

    def focus_input(self):
        app = self.A.NSRunningApplication.runningApplicationWithProcessIdentifier_(self.identity[1])
        if not app or not app.activateWithOptions_(self.A.NSApplicationActivateIgnoringOtherApps):
            raise RuntimeError("无法激活微信")
        time.sleep(.5)
        self.snapshot()
        self.foreground()
        bounds = self.identity[2]
        point = (bounds["X"] + bounds["Width"] * .65, bounds["Y"] + bounds["Height"] - 65)
        for kind in (self.Q.kCGEventLeftMouseDown, self.Q.kCGEventLeftMouseUp):
            event = self.Q.CGEventCreateMouseEvent(None, kind, point, self.Q.kCGMouseButtonLeft)
            self.Q.CGEventPost(self.Q.kCGHIDEventTap, event)
        time.sleep(.2)

    def key(self, code, command=False):
        self.foreground()
        for down in (True, False):
            event = self.Q.CGEventCreateKeyboardEvent(None, code, down)
            self.Q.CGEventSetFlags(event, self.Q.kCGEventFlagMaskCommand if command else 0)
            self.Q.CGEventPost(self.Q.kCGHIDEventTap, event)
        time.sleep(.2)


def send_once(ui, target, text=None, marker=None):
    board = ui.A.NSPasteboard.generalPasteboard()
    text_type = ui.A.NSPasteboardTypeString
    saved = []
    for item in board.pasteboardItems() or []:
        clone = ui.A.NSPasteboardItem.alloc().init()
        for kind in item.types():
            data = item.dataForType_(kind)
            if data is not None:
                clone.setData_forType_(data, kind)
        saved.append(clone)
    owned_count = None
    attempted = False
    marker = marker or "MACSEND" + uuid.uuid4().hex[:8].upper()
    text = f"{text.rstrip()}\n[{marker}]" if text is not None else f"微信助手收发测试 {marker}"

    def put(value):
        nonlocal owned_count
        board.clearContents()
        if not board.setString_forType_(value, text_type):
            raise RuntimeError("无法写入测试文字")
        owned_count = board.changeCount()

    def read_input():
        nonlocal owned_count
        sentinel = uuid.uuid4().hex
        put(sentinel)
        ui.key(0, command=True)  # Physical A, independent of input method.
        ui.key(8, command=True)  # Physical C.
        value = board.stringForType_(text_type)
        owned_count = board.changeCount()
        ui.key(124)  # Collapse selection without editing its contents.
        return "" if value == sentinel else value

    try:
        ui.snapshot()
        ui.focus_input()
        if read_input() != "":
            raise RuntimeError("输入区域已有内容或无法确认空白；未粘贴或发送测试消息")
        put(text)
        ui.key(9, command=True)  # Physical V.
        if read_input() != text:
            raise RuntimeError("输入框回读与测试文字不一致；未按发送键，请检查草稿")
        rows = ui.snapshot()
        locations = [r for r in rows if marker in r[0] and r[1] > .2]
        if len(locations) != 1 or not 0 < locations[0][2] < .35:
            raise RuntimeError("未确认测试文字位于输入区；未按发送键，请检查草稿")
        input_y = locations[0][2]
        print(f"目标：{target}；测试标记：{marker}。只尝试发送一次。", flush=True)
        ui.foreground()
        attempted = True  # Set before keydown: a subsequent failure is ambiguous.
        ui.key(36)  # Return; never retry if the user's send shortcut differs.
        for delay in (1, 2, 2):
            time.sleep(delay)
            rows = ui.snapshot()
            found = [r for r in rows if marker in r[0] and r[1] > .2]
            if len(found) == 1 and input_y + .03 < found[0][2] < .84:
                print("SEND_VISIBLE：目标聊天中已看到测试文字从输入区移入消息区。")
                print("这只确认本机界面状态，不表示对方已收到或已读。本次窗口临时截图已删除。")
                return 0
        raise RuntimeError("尚未在消息区确认测试文字")
    except Exception as error:
        status = "SEND_UNKNOWN：可能已发送，不要直接重跑；先人工查看聊天。" if attempted else "SEND_STOPPED：未按发送键。"
        print(status)
        print(str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        return 3 if attempted else 2
    finally:
        if owned_count is not None and board.changeCount() == owned_count:
            board.clearContents()
            if saved:
                board.writeObjects_(saved)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, help="已人工确认的唯一联系人备注")
    parser.add_argument("--send-once", action="store_true", help="明确执行一条测试消息的发送")
    args = parser.parse_args()
    if not args.send_once:
        parser.error("需要 --send-once；默认不执行发送")
    try:
        sys.exit(send_once(WechatUI(args.target), args.target))
    except Exception as error:
        sys.exit(str(error) if isinstance(error, RuntimeError) else type(error).__name__)
