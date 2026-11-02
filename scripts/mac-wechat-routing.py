#!/usr/bin/env python3
"""Two explicit, pinned contacts: staff reports and boss queries on a visible Mac."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("routing_pilot", ROOT / "scripts/mac-wechat-pilot.py")
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)
sender = pilot.ui_module


def roles(staff, boss):
    if (not staff.strip() or not boss.strip() or staff != staff.strip() or boss != boss.strip()
            or len(staff) > 40 or len(boss) > 40
            or any(ord(c) < 32 for c in staff + boss)
            or sender.compact(staff) == sender.compact(boss)):
        raise RuntimeError("员工与老板必须是两个不同、非空且唯一的联系人备注（不含首尾空格）")
    return {"mode": "two-contact-pilot-v1", "staff": staff, "boss": boss}


def header(rows, bounds, contacts, expected=None):
    lower = max(.84, 1 - 65 / bounds["Height"])
    names = {sender.compact(name): name for name in contacts}
    matches = [(names[sender.compact(r["text"])], r) for r in rows
               if r["x"] > .2 and r["y"] > lower and sender.compact(r["text"]) in names]
    if len(matches) != 1 or (expected is not None and matches[0][0] != expected):
        raise RuntimeError("CHAT_TITLE：未唯一确认指定聊天标题；请打开员工或老板的私聊，停止后再检查布局")
    return matches[0]


def sidebar_row(rows, target, title, bounds):
    lower = max(.84, 1 - 65 / bounds["Height"])
    matches = [r for r in rows if sender.compact(r["text"]) == sender.compact(target)
               and .04 < r["x"] and r["x"] + r["w"] < title["x"] - .01
               and .1 < r["y"] + r["h"] / 2 < lower - .005]
    if len(matches) != 1:
        raise RuntimeError(f"CONTACT_LIST：侧栏中“{target}”精确匹配 {len(matches)} 处；请把两个私聊置顶并保持备注完整可见")
    return matches[0]


def require_empty_input(ui):
    """Read without editing, and retain another application's clipboard changes."""
    ui.focus_input()
    board, kind = ui.A.NSPasteboard.generalPasteboard(), ui.A.NSPasteboardTypeString
    saved = []
    for item in board.pasteboardItems() or []:
        clone = ui.A.NSPasteboardItem.alloc().init()
        for data_type in item.types():
            data = item.dataForType_(data_type)
            if data is not None: clone.setData_forType_(data, data_type)
        saved.append(clone)
    owned = None
    try:
        sentinel = uuid.uuid4().hex
        board.clearContents()
        if not board.setString_forType_(sentinel, kind):
            raise RuntimeError("切换聊天前无法核对输入框")
        owned = board.changeCount()
        ui.key(0, command=True)
        ui.key(8, command=True)
        value = board.stringForType_(kind)
        # Nonempty data may be a user's concurrent copy; never overwrite it.
        if value != sentinel:
            owned = None
        ui.key(124)
        if value != sentinel:
            raise RuntimeError("切换前发现草稿或输入焦点不明；未切换聊天，请先检查输入框")
        ui.snapshot()
    finally:
        if owned is not None and board.changeCount() == owned:
            board.clearContents()
            if saved: board.writeObjects_(saved)


class RoutingUI(sender.WechatUI):
    def __init__(self, staff, boss):
        super().__init__(staff)
        self.contacts = (staff, boss)
        self.expected = None
        self.current = None
        self.details = []
        self.title = None

    def verify_title(self, details):
        self.current, self.title = header(details, self.identity[2], self.contacts, self.expected)
        self.details = details

    def open_contact(self, target):
        if target not in self.contacts:
            raise RuntimeError("拒绝切换到配置以外的联系人")
        # Only the first frame may establish either configured contact. Once
        # established, an unexpected human chat switch stops the runner.
        self.snapshot()
        self.expected = self.current
        if self.current == target:
            self.target = target
            return
        require_empty_input(self)
        # The last snapshot, after checking the editor, supplies fresh coordinates.
        row = sidebar_row(self.details, target, self.title, self.identity[2])
        self.foreground()
        bounds = self.identity[2]
        point = (bounds["X"] + (row["x"] + row["w"] / 2) * bounds["Width"],
                 bounds["Y"] + (1 - row["y"] - row["h"] / 2) * bounds["Height"])
        self.expected = target
        for kind in (self.Q.kCGEventLeftMouseDown, self.Q.kCGEventLeftMouseUp):
            event = self.Q.CGEventCreateMouseEvent(None, kind, point, self.Q.kCGMouseButtonLeft)
            self.Q.CGEventPost(self.Q.kCGHIDEventTap, event)
        time.sleep(.7)
        self.snapshot()  # Wrong/ambiguous titles stop before any paste or processing.
        self.target = target
        print(f"CHAT_READY：{target}", flush=True)

    def message_rows(self, reader):
        # Exclude contact-list previews even when they look like full commands.
        return [r for r in reader.rows if r["x"] > self.title["x"] + .01]


class RoutingState(pilot.PilotState):
    def __init__(self, directory, staff, boss):
        self.scope = roles(staff, boss)
        super().__init__(directory, staff, scope=self.scope)
        self.db.execute("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT)")
        self.db.commit()

    def scoped(self, request):
        if request.get("source") not in (self.scope["staff"], self.scope["boss"]):
            raise RuntimeError("请求来源不在联系人配置中")
        role = "staff" if request["source"] == self.scope["staff"] else "boss"
        return {**request, "requestId": role + ":" + request["requestId"]}

    def seen(self, request):
        return super().seen(self.scoped(request))

    def begin(self, request, evidence):
        return super().begin(self.scoped(request), evidence)

    def finish_request(self, request, status):
        super().finish(self.scoped(request)["requestId"], status)

    def initialized(self):
        return self.db.execute("SELECT 1 FROM metadata WHERE key='initialized'").fetchone() is not None

    def initialize(self):
        self.db.execute("INSERT OR REPLACE INTO metadata VALUES('initialized','1')")
        self.db.commit()


class RoutingBridge(pilot.Bridge):
    def __init__(self, node, state, staff, boss, interval=300, ui=None):
        self.boss = boss
        super().__init__(node, state, staff, ui, boss=boss, interval=interval)

    def send(self, message, marker):
        target = message.get("target")
        if target not in (self.peer, self.boss):
            raise RuntimeError("汇报服务未提供合法收件人，未发送")
        self.ui.open_contact(target)
        return sender.send_once(self.ui, target, str(message["text"]), marker)


class Intake:
    def __init__(self, staff, boss, state, bridge):
        self.staff, self.boss, self.state, self.bridge = staff, boss, state, bridge
        self.previous = {staff: {}, boss: {}}
        self.warned = set()

    def requests(self, peer, rows, input_top):
        if peer not in self.previous: raise RuntimeError("采集来源不在联系人配置中")
        requests = pilot.parse_requests(rows, input_top, allow_query=True)
        allowed = {"report"} if peer == self.staff else {"summary", "detail", "query"}
        grouped = {}
        for request in requests:
            if request["action"] not in allowed:
                key = (peer, request["requestId"], "role")
                if key not in self.warned:
                    print(f"ROLE_SKIP：{peer} 的 {request['requestId']} 不符合当前角色，未处理。", flush=True)
                    self.warned.add(key)
                continue
            grouped.setdefault(request["requestId"], []).append({**request, "source": peer})
        result = []
        for rid, group in grouped.items():
            if len({pilot.fingerprint(r) for r in group}) > 1:
                key = (peer, rid, "conflict")
                if key not in self.warned:
                    print(f"CONFLICT_SKIP：{peer} 的 {rid} 在同一画面有不同内容，请换编号重新提交。", flush=True)
                    self.warned.add(key)
            else:
                result.append(group[0])
        return result

    def baseline(self, peer, rows, input_top):
        for request in self.requests(peer, rows, input_top):
            if not self.state.seen(request):
                self.state.begin(request, "startup-baseline")
                self.state.finish_request(request, "baseline")

    def observe(self, peer, rows, input_top, reader):
        requests = self.requests(peer, rows, input_top)
        current = {r["requestId"]: pilot.fingerprint(r) for r in requests}
        previous, self.previous[peer] = self.previous[peer], current
        for request in requests:
            seen = self.state.seen(request)
            if seen:
                key = (peer, request["requestId"], "seen")
                if (seen[0] != pilot.fingerprint(self.state.scoped(request)) or seen[1] == "unknown") and key not in self.warned:
                    print(f"SEEN_SKIP：{peer} 的 {request['requestId']} 已使用或未确认；请查询记录，不自动重试。", flush=True)
                    self.warned.add(key)
                continue
            if previous.get(request["requestId"]) != current[request["requestId"]]: continue
            observation = uuid.uuid4().hex
            reader.evidence(self.state.directory, request["rows"], observation)
            self.state.begin(request, observation)
            try:
                status = self.bridge.call({k: request[k] for k in ("requestId", "action", "text", "source")}
                                          | {"observationId": observation})
                self.state.finish_request(request, "done")
            except BaseException:
                self.state.finish_request(request, "unknown")
                raise
            self.previous = {self.staff: {}, self.boss: {}}
            print(f"已处理 {peer} / {request['requestId']}；共 {status['count']} 条，待汇总 {status['pending']} 条。", flush=True)
            return True
        return False


def listen(ui, reader, intake, boundaries, bridge, interval):
    next_flush = time.monotonic() + interval
    next_status = time.monotonic()
    while True:
        for peer in (intake.staff, intake.boss):
            ui.open_contact(peer)
            for _ in range(2):
                ui.snapshot()
                if intake.observe(peer, ui.message_rows(reader), boundaries[peer], reader): break
                time.sleep(1)
            if time.monotonic() >= next_flush:
                status = bridge.call({"action": "flush"})
                intake.previous = {intake.staff: {}, intake.boss: {}}
                print(f"汇总周期完成：待汇总 {status['pending']} 条，未确认批次 {status['unconfirmed']}。", flush=True)
                next_flush = time.monotonic() + interval
            if time.monotonic() >= next_status:
                print(f"监听中：员工 {intake.staff} → 老板 {intake.boss}；Ctrl+C 停止。", flush=True)
                next_status = time.monotonic() + 30
        time.sleep(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staff", required=True, help="员工唯一备注")
    parser.add_argument("--boss", required=True, help="老板唯一备注")
    parser.add_argument("--interval", type=int, default=300, help="汇总周期秒数，默认 300，最小 60")
    parser.add_argument("--data-root", type=Path, default=Path.home()/"wechat-assistant"/"routing-data")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--check-service", action="store_true", help="只检查本地服务，不操作微信")
    modes.add_argument("--check-contacts", action="store_true", help="只切换并核对两个置顶私聊，不发送消息")
    args = parser.parse_args()
    scope = roles(args.staff, args.boss)
    if not 60 <= args.interval <= 86400: raise RuntimeError("汇总周期应为 60–86400 秒")
    if sys.platform != "darwin" and not args.check_service: raise RuntimeError("请在 Mac 上运行")
    os.umask(0o077)
    bridge, state, reader, desktop = None, None, None, None
    try:
        if args.check_contacts:
            desktop = sender.DesktopLock()
            ui = RoutingUI(args.staff, args.boss)
            for peer in (args.staff, args.boss, args.staff):
                ui.open_contact(peer)
                require_empty_input(ui)
            print("CONTACTS_OK：两个私聊已切换并核对；没有发送消息或保存聊天截图。", flush=True)
            return
        directory = args.data_root / hashlib.sha256(json.dumps(scope, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
        state = RoutingState(directory, args.staff, args.boss)
        node = pilot.node_path()
        print(f"Node：{node}", flush=True)
        bridge = RoutingBridge(node, state, args.staff, args.boss, args.interval)
        status = bridge.call({"action": "status"})
        if args.check_service:
            print(f"SERVICE_OK：员工 {args.staff}；老板 {args.boss}；已有 {status['count']} 条，未确认 {status['unconfirmed']} 批。没有操作微信。", flush=True)
            return
        desktop = sender.DesktopLock()
        reader = pilot.Reader()
        ui = RoutingUI(args.staff, args.boss)
        ui.on_frame = reader.frame
        bridge.ui = ui
        intake = Intake(args.staff, args.boss, state, bridge)
        # Verify both contacts and drafts before sending either calibration.
        for peer in (args.staff, args.boss, args.staff):
            ui.open_contact(peer)
            require_empty_input(ui)
            if not state.initialized(): intake.baseline(peer, ui.message_rows(reader), .08)
        boundaries = {}
        for peer in (args.staff, args.boss):
            ui.open_contact(peer)
            role = "员工" if peer == args.staff else "老板"
            note = f"双联系人试运行正在校准：{role} {peer}。请等运行终端显示 READY 后，再提交汇报或查询。"
            boundaries[peer] = pilot.calibrate(ui, reader, peer, state, note)
            if not state.initialized(): intake.baseline(peer, ui.message_rows(reader), boundaries[peer])
        state.initialize()
        print(f"READY：员工 {args.staff} → 老板 {args.boss}；每 {args.interval} 秒汇总。保持两个私聊置顶、窗口可见、输入框空白。", flush=True)
        print(f"员工：汇报 A101 合同已确认，预计周五回款 #END\n老板：汇总 Q101 #END\n老板：详情 Q102 R000001 #END\n老板：查询 Q103 {args.staff}回款的细节 #END", flush=True)
        print(f"数据目录：{directory}\n普通聊天不采集；新请求换编号。Ctrl+C 停止，已有记录保留。", flush=True)
        listen(ui, reader, intake, boundaries, bridge, args.interval)
    finally:
        if bridge: bridge.close()
        if reader and reader.image is not None: reader.image.close()
        if desktop: desktop.close()
        if state: state.close()


if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: print("已停止；已有记录保留。")
    except Exception as error:
        print("已停止：" + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
