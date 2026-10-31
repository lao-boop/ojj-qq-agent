import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("pilot", Path(__file__).resolve().parents[1]/"scripts/mac-wechat-pilot.py")
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


def row(text, y=.6, direction="incoming", confidence=.99):
    return {"text": text, "x": .4, "y": y, "w": .3, "h": .02, "direction": direction, "confidence": confidence}


class ParserTests(unittest.TestCase):
    def test_multiline_complete_report_and_queries(self):
        rows = [row("汇报 A01 项目A已经交付", .7), row("尾款明天到账 #END", .67), row("汇总 Q01 #END", .5), row("详情 Q02 R000001 #END", .4)]
        result = pilot.parse_requests(rows, .25)
        self.assertEqual([r["action"] for r in result], ["report", "summary", "detail"])
        self.assertEqual(result[0]["text"], "项目A已经交付 尾款明天到账")

    def test_self_messages_drafts_and_incomplete_frames_are_ignored(self):
        for rows in [
            [row("汇报 A01 自己发出的示例 #END", direction="self")],
            [row("汇报 A01 未发送草稿 #END", y=.1)],
            [row("汇报 A01 看不完整的内容")],
            [row("汇报 A01 第一条", .7), row("另一个气泡 #END", .3)],
            [row("汇报 A01 低置信度 #END", confidence=.4)],
            [row("汇报 A01 包含 汇总 Q01 #END")],
        ]:
            self.assertEqual(pilot.parse_requests(rows,.25), [])

    def test_plain_chat_and_bad_ids_never_become_reports(self):
        for text in ["普通聊天", "汇报 A01 这个任务已经结束", "汇报 A1234567 内容 #END", "详情 Q01 not-an-id #END", "汇总 Q01 多余指令 #END"]:
            self.assertEqual(pilot.parse_requests([row(text)], .25), [])

    def test_body_ending_word_is_retained_and_ids_normalized(self):
        result = pilot.parse_requests([row("汇报 a01 项目已经结束 ＃end")], .25)
        self.assertEqual(result[0]["requestId"], "A01")
        self.assertEqual(result[0]["text"], "项目已经结束")

    def test_summary_pages_must_have_a_bounded_positive_page(self):
        result = pilot.parse_requests([row("汇总 Q03 第2页 #END")], .25)
        self.assertEqual(result[0]["text"], "第2页")
        for page in ["第0页", "第-1页", "第100000页"]:
            self.assertEqual(pilot.parse_requests([row(f"汇总 Q04 {page} #END")], .25), [])


class ReaderTests(unittest.TestCase):
    def test_bubble_direction_and_saved_evidence_crop(self):
        from PIL import Image, ImageDraw
        with tempfile.TemporaryDirectory() as folder:
            image = Image.new("RGB", (1000, 800), "#ededed")
            draw = ImageDraw.Draw(image)
            rows = [row("汇报 A01 正文 #END", .7), row("汇报 A02 自发 #END", .5), row("汇报 A03 不确定 #END", .3)]
            for r, color in zip(rows, ["white", "#95ec69", "#404040"]):
                draw.rectangle((r['x']*1000, (1-r['y']-r['h'])*800, (r['x']+r['w'])*1000, (1-r['y'])*800), fill=color)
            filename = Path(folder)/"frame.png"
            image.save(filename); image.close()
            reader = pilot.Reader()
            try:
                reader.frame(filename, rows)
                self.assertEqual([r["direction"] for r in reader.rows], ["incoming", "self", "unknown"])
                requests = pilot.parse_requests(reader.rows, .25)
                self.assertEqual([r['requestId'] for r in requests], ['A01'])
                reader.evidence(folder, requests[0]['rows'], 'proof')
                evidence = Path(folder)/"evidence/proof.png"
                self.assertEqual(evidence.stat().st_mode & 0o777, 0o600)
                with Image.open(evidence) as crop:
                    self.assertLess(crop.width, 400)
                    self.assertLess(crop.height, 50)
            finally:
                if reader.image: reader.image.close()


class BridgeTests(unittest.TestCase):
    def test_python_and_node_exchange_requests_and_persist_gui_outcomes(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict('os.environ', {'DEEPSEEK_API_KEY': ''}):
            state = pilot.PilotState(folder, "测试联系人")
            bridge = pilot.Bridge(pilot.node_path(), state, "测试联系人", object())
            replies = []
            def visible(ui, peer, text, marker):
                self.assertEqual(peer, "测试联系人")
                replies.append(text)
                return 0
            try:
                with patch.object(pilot.ui_module, "send_once", side_effect=visible):
                    status = bridge.call({'action':'report','requestId':'A01','text':'尾款周五到账','observationId':'frame-1'})
                    self.assertEqual(status['count'], 1)
                    bridge.call({'action':'detail','requestId':'Q01','text':'R000001'})
                    self.assertIn('尾款周五到账', replies[-1])
                    self.assertIn('本地观察 ID：frame-1', replies[-1])
                    self.assertTrue(all(r[0]=='visible' for r in state.db.execute('SELECT state FROM sends')))
                with patch.object(pilot.ui_module, "send_once", return_value=3) as send:
                    with self.assertRaisesRegex(RuntimeError, '不自动重试'):
                        bridge.call({'action':'summary','requestId':'Q02','text':''})
                    self.assertEqual(send.call_count, 1)
                self.assertEqual(state.db.execute("SELECT count(*) FROM sends WHERE state='unknown'").fetchone()[0], 1)
                self.assertEqual(len(json.loads(Path(folder,'reports.json').read_text())['records']), 1)
            finally:
                bridge.close(); state.close()


class StateTests(unittest.TestCase):
    def test_restarts_keep_completed_ids_and_mark_interrupted_work_unknown(self):
        with tempfile.TemporaryDirectory() as folder:
            state = pilot.PilotState(folder, "测试联系人")
            a = {"requestId":"A01", "action":"report", "text":"合同完成"}
            b = {"requestId":"A02", "action":"report", "text":"更正时间"}
            state.begin(a, "evidence-a"); state.finish("A01", "done")
            state.begin(b, "evidence-b"); state.send_state("delivery", "sending")
            state.close()
            restored = pilot.PilotState(folder, "测试联系人")
            self.assertEqual(restored.seen(a)[1], "done")
            self.assertEqual(restored.seen(b)[1], "unknown")
            self.assertEqual(restored.db.execute("SELECT state FROM sends").fetchone()[0], "unknown")
            self.assertEqual(Path(folder,"pilot.sqlite").stat().st_mode & 0o777, 0o600)
            restored.close()

    def test_a_second_process_or_different_peer_cannot_take_over_data(self):
        with tempfile.TemporaryDirectory() as folder:
            state = pilot.PilotState(folder, "测试联系人")
            with self.assertRaisesRegex(RuntimeError, "已在运行"): pilot.PilotState(folder, "测试联系人")
            state.close()
            with self.assertRaisesRegex(RuntimeError, "独立试点目录"): pilot.PilotState(folder, "另一个联系人")

    def test_existing_report_database_without_pilot_scope_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder,"reports.json").write_text('{"private":"keep"}')
            with self.assertRaisesRegex(RuntimeError,"拒绝接管"): pilot.PilotState(folder,"测试联系人")
            self.assertEqual(json.loads(Path(folder,"reports.json").read_text()), {"private":"keep"})


if __name__ == "__main__": unittest.main()
