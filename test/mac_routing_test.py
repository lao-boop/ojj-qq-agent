import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from mac_send_check_test import UI as Editor

spec = importlib.util.spec_from_file_location("routing", Path(__file__).resolve().parents[1]/"scripts/mac-wechat-routing.py")
routing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routing)


def row(text, x=.44, y=.6, confidence=.5, direction="incoming"):
    return dict(text=text, x=x, y=y, w=.12, h=.025, confidence=confidence, direction=direction)


class LayoutUI(routing.RoutingUI):
    def __init__(self, wrong_click=False, draft=""):
        self.contacts = ("一鸣", "老")
        self.target, self.current, self.expected = "一鸣", None, None
        self.actual = "一鸣"
        self.identity = (1, 2, {"Width": 880, "Height": 569, "X": 20, "Y": 30})
        self.title, self.details = None, []
        self.editor = Editor(draft=draft)
        self.A = self.editor.A
        self.clicks = 0
        self.wrong_click = wrong_click
        self.Q = types.SimpleNamespace(kCGEventLeftMouseDown=1, kCGEventLeftMouseUp=2,
                                      kCGMouseButtonLeft=0, kCGHIDEventTap=0,
                                      CGEventCreateMouseEvent=lambda _, kind, point, button: (kind, point),
                                      CGEventPost=self.post)

    def snapshot(self):
        rows = [row(self.actual, x=.355, y=.939), row("一鸣", x=.14, y=.82), row("老", x=.14, y=.68)]
        self.verify_title(rows)
        return []

    def focus_input(self): self.snapshot()
    def foreground(self): pass
    def key(self, code, command=False): self.editor.key(code, command)
    def post(self, tap, event):
        if event[0] == 2:
            self.clicks += 1
            y = 1 - (event[1][1] - 30) / 569
            self.actual = "陌生人" if self.wrong_click else "一鸣" if y > .75 else "老"


class RoutingUITests(unittest.TestCase):
    def test_header_is_distinguished_from_first_sidebar_contact(self):
        bounds = {"Height": 569}
        rows = [row("一鸣", x=.355, y=.939), row("老", x=.27, y=.861)]
        self.assertEqual(routing.header(rows, bounds, ("一鸣", "老"))[0], "一鸣")
        with self.assertRaisesRegex(RuntimeError, "CHAT_TITLE"):
            routing.header(rows, bounds, ("一鸣", "老"), "老")
        with self.assertRaises(RuntimeError):
            routing.header([row("一呜", y=.939)], bounds, ("一鸣", "老"))

    def test_switch_checks_title_and_restores_clipboard(self):
        ui = LayoutUI()
        with patch.object(routing.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            ui.open_contact("老")
            self.assertEqual((ui.current, ui.expected, ui.target), ("老", "老", "老"))
            ui.open_contact("一鸣")
        self.assertEqual(ui.clicks, 2)
        self.assertEqual(ui.editor.sent, [])
        self.assertEqual(ui.editor.board.items[0].values, {"text": "原有剪贴板", "image/png": b"image"})

    def test_draft_blocks_switch_and_is_not_changed(self):
        ui = LayoutUI(draft="用户草稿")
        with self.assertRaisesRegex(RuntimeError, "草稿"):
            ui.open_contact("老")
        self.assertEqual(ui.clicks, 0)
        self.assertEqual(ui.editor.buffer, "用户草稿")

    def test_wrong_click_or_unexpected_human_switch_cannot_supply_report_source(self):
        ui = LayoutUI(wrong_click=True)
        with patch.object(routing.time, "sleep"), self.assertRaisesRegex(RuntimeError, "CHAT_TITLE"):
            ui.open_contact("老")
        self.assertEqual(ui.clicks, 1)
        self.assertEqual(ui.editor.sent, [])
        ui = LayoutUI()
        ui.open_contact("一鸣")
        ui.actual = "老"
        with self.assertRaisesRegex(RuntimeError, "CHAT_TITLE"):
            ui.open_contact("老")

    def test_ambiguous_sidebar_or_unknown_recipient_is_rejected(self):
        title = row("一鸣", x=.355, y=.939)
        for candidates in ([], [row("老", x=.14, y=.82), row("老", x=.14, y=.68)]):
            with self.assertRaisesRegex(RuntimeError, "CONTACT_LIST"):
                routing.sidebar_row(candidates, "老", title, {"Height": 569})
        with self.assertRaises(RuntimeError): LayoutUI().open_contact("其他人")

    def test_complete_command_in_sidebar_is_not_in_the_inbox(self):
        ui = LayoutUI()
        ui.snapshot()
        reader = Mock(rows=[row("汇报 A10 侧栏预览 #END", x=.25), row("汇报 A11 正文 #END")])
        self.assertEqual([r["text"] for r in ui.message_rows(reader)], ["汇报 A11 正文 #END"])

    def test_shared_desktop_lock_blocks_other_runner(self):
        with tempfile.TemporaryDirectory() as folder:
            first = routing.sender.DesktopLock(folder)
            try:
                with self.assertRaisesRegex(RuntimeError, "另一个助手"):
                    routing.sender.DesktopLock(folder)
            finally: first.close()
            routing.sender.DesktopLock(folder).close()


class RoutingFlowTests(unittest.TestCase):
    def test_staff_intake_timer_digest_and_boss_details_use_real_backend(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict("os.environ", {"DEEPSEEK_API_KEY": ""}):
            state = routing.RoutingState(folder, "一鸣", "老")
            ui = Mock()
            sends = []
            def send(interface, target, text, marker):
                sends.append((target, text))
                return 0
            bridge = None
            try:
                with contextlib.redirect_stdout(io.StringIO()), patch.object(routing.sender, "send_once", side_effect=send):
                    bridge = routing.RoutingBridge(routing.pilot.node_path(), state, "一鸣", "老", 60, ui)
                    intake = routing.Intake("一鸣", "老", state, bridge)
                    reader = Mock()
                    command = [row("汇报 A101 合同已确认，回款尚未到账 #END")]
                    self.assertFalse(intake.observe("一鸣", command, .25, reader))
                    self.assertTrue(intake.observe("一鸣", command, .25, reader))
                    self.assertEqual(sends[0][0], "一鸣")
                    self.assertIn("提交老板", sends[0][1])
                    clock = [0.0]
                    def sleep(seconds):
                        clock[0] += seconds
                        if clock[0] > 68: raise KeyboardInterrupt
                    ui.message_rows.return_value = []
                    with patch.object(routing.time, "monotonic", side_effect=lambda: clock[0]), \
                         patch.object(routing.time, "sleep", side_effect=sleep), self.assertRaises(KeyboardInterrupt):
                        routing.listen(ui, reader, intake, {"一鸣": .25, "老": .25}, bridge, 60)
                    self.assertEqual(sends[1][0], "老")
                    self.assertIn("工作汇报", sends[1][1])
                    self.assertIn("合同已确认", sends[1][1])
                    # Same request ID is independent across people; only the boss can query.
                    detail = [row("详情 A101 R000001 #END")]
                    self.assertFalse(intake.observe("老", detail, .25, reader))
                    self.assertTrue(intake.observe("老", detail, .25, reader))
                    self.assertEqual(sends[-1][0], "老")
                    self.assertIn("回款尚未到账", sends[-1][1])
                    self.assertIn("截图识别文字", sends[-1][1])
                    count = len(sends)
                    for _ in range(3): intake.observe("一鸣", detail, .25, reader)
                    self.assertEqual(len(sends), count)
                    query = [row("查询 Q103 一鸣回款的细节 #END")]
                    intake.observe("老", query, .25, reader)
                    self.assertTrue(intake.observe("老", query, .25, reader))
                    self.assertIn("回款尚未到账", sends[-1][1])
                    stored = json.loads((Path(folder)/"reports.json").read_text())
                    self.assertEqual(stored["records"][0]["text"], "合同已确认，回款尚未到账")
                    self.assertEqual(stored["records"][0]["senderName"], "一鸣")
                    self.assertEqual(stored["deliveries"][0]["targetId"], "老")
                    self.assertEqual(stored["deliveries"][0]["status"], "sent")
                    self.assertEqual(reader.evidence.call_count, 3)
            finally:
                if bridge: bridge.close()
                state.close()
            restored = routing.RoutingState(folder, "一鸣", "老")
            try:
                request = dict(source="一鸣", requestId="A101", action="report", text="合同已确认，回款尚未到账")
                self.assertEqual(restored.seen(request)[1], "done")
            finally: restored.close()

    def test_first_start_baseline_conflicts_and_stability_do_not_ingest_old_or_unstable_text(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()):
            state = routing.RoutingState(folder, "一鸣", "老")
            try:
                bridge = Mock()
                reader = Mock()
                intake = routing.Intake("一鸣", "老", state, bridge)
                old = [row("汇报 A12 旧单联系人测试 #END")]
                intake.baseline("一鸣", old, .25)
                state.initialize()
                self.assertTrue(state.initialized())
                for frame in (old, old, [row("汇报 A13 第一帧 #END")], [row("汇报 A13 第二帧 #END")],
                              [row("汇报 A14 内容一 #END", y=.7), row("汇报 A14 内容二 #END", y=.5)],
                              [row("汇报 A15 本人自发 #END", direction="self")]):
                    self.assertFalse(intake.observe("一鸣", frame, .25, reader))
                bridge.call.assert_not_called()
                reader.evidence.assert_not_called()
            finally: state.close()

    def test_role_scope_cannot_reuse_single_peer_data_or_swap_roles(self):
        with tempfile.TemporaryDirectory() as folder:
            state = routing.RoutingState(folder, "一鸣", "老")
            state.close()
            with self.assertRaisesRegex(RuntimeError, "独立试点目录"):
                routing.RoutingState(folder, "老", "一鸣")
        for staff, boss in [("一鸣", "一 鸣"), ("", "老"), ("一鸣", " 老")]:
            with self.assertRaises(RuntimeError): routing.roles(staff, boss)

    def test_query_is_explicit_and_not_enabled_in_original_single_peer_parser(self):
        frame = [row("查询 Q01 一鸣回款的细节 #END")]
        self.assertEqual(routing.pilot.parse_requests(frame, .25), [])
        self.assertEqual(routing.pilot.parse_requests(frame, .25, allow_query=True)[0]["action"], "query")
        for text in ["随便聊聊", "查询 Q01 /重发 D000001 #END", "查询 Q01 缺少结束标记"]:
            self.assertEqual(routing.pilot.parse_requests([row(text)], .25, allow_query=True), [])


if __name__ == "__main__": unittest.main()
