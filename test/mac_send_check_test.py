import contextlib
import importlib.util
import io
from pathlib import Path
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "send_check", Path(__file__).resolve().parents[1] / "scripts/mac-wechat-send-check.py"
)
send_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(send_check)


class Item:
    def __init__(self, values=None): self.values = values or {}
    @classmethod
    def alloc(cls): return cls()
    def init(self): return self
    def types(self): return list(self.values)
    def dataForType_(self, kind): return self.values.get(kind)
    def setData_forType_(self, data, kind): self.values[kind] = data


class Board:
    def __init__(self):
        self.items = [Item({"text": "原有剪贴板", "image/png": b"image"})]
        self.count = 0
    def pasteboardItems(self): return self.items
    def changeCount(self): return self.count
    def clearContents(self): self.items = []; self.count += 1
    def setString_forType_(self, value, kind):
        self.items = [Item({kind: value})]; self.count += 1; return True
    def stringForType_(self, kind): return self.items[0].values.get(kind) if self.items else None
    def writeObjects_(self, items): self.items = items; self.count += 1


class UI:
    def __init__(self, draft="", error=""):
        self.board = Board()
        self.buffer, self.error = draft, error
        self.sent = []
        self.A = types.SimpleNamespace(
            NSPasteboard=types.SimpleNamespace(generalPasteboard=lambda: self.board),
            NSPasteboardTypeString="text", NSPasteboardItem=Item,
        )
    def foreground(self): pass
    def focus_input(self): pass
    def snapshot(self):
        if self.error == "target": raise RuntimeError("目标不符")
        if self.buffer:
            return [(send_check.compact(self.buffer), .5, .15)]
        if self.sent:
            if self.error == "unconfirmed": return []
            if self.error == "user clipboard": self.board.setString_forType_("用户新复制内容", "text")
            return [(send_check.compact(self.sent[-1]), .6, .4)]
        return []
    def key(self, code, command=False):
        if code == 8 and self.buffer:
            self.board.setString_forType_(self.buffer, "text")
        if code == 9:
            self.buffer += self.board.stringForType_("text")
            if self.error == "paste": self.buffer += "意外内容"
        if code == 36:
            self.sent.append(self.buffer)
            self.buffer = ""


class SendCheckTests(unittest.TestCase):
    def run_check(self, ui):
        output = io.StringIO()
        with patch.object(send_check.time, "sleep"), contextlib.redirect_stdout(output):
            code = send_check.send_once(ui, "测试联系人")
        return code, output.getvalue()

    def test_visible_bubble_sends_once_and_restores_clipboard_types(self):
        ui = UI()
        code, output = self.run_check(ui)
        self.assertEqual(code, 0)
        self.assertIn("SEND_VISIBLE", output)
        self.assertEqual(len(ui.sent), 1)
        self.assertEqual(ui.board.items[0].values, {"text": "原有剪贴板", "image/png": b"image"})

    def test_existing_draft_is_neither_overwritten_nor_sent(self):
        ui = UI(draft="原有草稿")
        code, output = self.run_check(ui)
        self.assertEqual(code, 2)
        self.assertEqual(ui.buffer, "原有草稿")
        self.assertFalse(ui.sent)
        self.assertNotIn("原有草稿", output)

    def test_wrong_target_does_not_type(self):
        ui = UI(error="target")
        self.assertEqual(self.run_check(ui)[0], 2)
        self.assertFalse(ui.sent)
        self.assertEqual(ui.buffer, "")

    def test_paste_mismatch_never_presses_send(self):
        ui = UI(error="paste")
        self.assertEqual(self.run_check(ui)[0], 2)
        self.assertFalse(ui.sent)

    def test_uncertain_send_is_not_retried(self):
        ui = UI(error="unconfirmed")
        code, output = self.run_check(ui)
        self.assertEqual(code, 3)
        self.assertIn("SEND_UNKNOWN", output)
        self.assertEqual(len(ui.sent), 1)

    def test_new_user_clipboard_is_not_overwritten(self):
        ui = UI(error="user clipboard")
        self.assertEqual(self.run_check(ui)[0], 0)
        self.assertEqual(ui.board.stringForType_("text"), "用户新复制内容")


if __name__ == "__main__":
    unittest.main()
