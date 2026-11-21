> 历史记录：下文描述2026-11-20当时的实验。当前入口见 [README](README.md)，不能把这里的“升级版”当作现版本。

# 小鲸鱼定时汇报：原版 / 升级版对照实验

基线提交：`cf06a72084811d84cb8388c1bbf2a549e20b2f22`，2026-11-20 重新核对远端 `codex/wecom-integration` 与工作树 HEAD 相同。升级改动在 `/workspace/ojj-wecom-update`；原 `/workspace/ojj-qq-agent` 保留，未覆盖。Mac 安装版本与云端修改是两回事，本实验不会更新正在运行的机器人。

## 改了哪里

原版一次调用 `writeBriefing` 直接生成段落，主要检查输出格式与消息编号。

升级版只替换定时汇报的生成器，使用 `src/wecom-scheduled-briefing.js`：

1. 按事项整理重点、事实状态、逐字引文和更正关系。事实保留归属、条件、时间范围和未定之处。
2. 同时提供全部已选原文和事项记录，写自然短汇报；重要变化在前，不添加商业推断或管理建议。
3. 程序校验引用子串、编号、关系、失效事实引用和重点覆盖。两步各可重试一次，失败保留待处理记录，不发送未校验结果。

正常每批两次模型调用；比原版多一次，成本和延迟需随真实结果观察。程序不能证明事实解释正确，也不能通过引用顺序证明正文真的重要在前。相同模型两步可能产生相同盲点。论文方法、证据边界见 [RESEARCH.md](RESEARCH.md)。

## 保持的链路与边界

- `wecom-runtime.js` 先检查访问范围，再 `secretary.capture` 存档，随后才聊天。
- `secretary.tick` 仍只在到期且有其他成员新增消息时私聊配置负责人（实验为 HuangZiMing）。QQ 和主动查询使用原来路径。
- 每轮最多40条，单批最多20条/约9000字符。`briefingMaterial` 仍选择新增原文及有限同会话前文，以 `contextOnly` 标记；没有扩展为全历史检索。
- 两步读同一份原文，不从模型摘要建立永久事实库。原文档案保持可追溯；长消息截断、跨批次更正和远历史缺失仍是限制。
- 生成后保存 outbox；确认发送 ACK 后才推进 cursor/latestSources。重试复用已有文本，真实 ACK 丢失仍可能重复投递。
- 生成中停止或更换接收人，不再启动下一模型阶段或向旧接收人投递。

## 基线保存与实验方法

`baseline-briefing.js` 是基线提交 `src/wecom-briefing.js` 的逐字副本，SHA256 为 `393e10fa4ee9fdaf6f80906dbe5d48a5d50727da5e65e07b9afa9da351286923`，运行器会校验。基线模式使用同一个真实 tick/原文选择/投递路径，仅注入冻结的原版生成器。其他相关逻辑本次没有修改。

开发组3组：续约变化、物流变化、一切正常。每组原版原话、只变关键事实、只变无关细节，共9个版本。

保留组2组：人员替补、到账状态，每组3版；含上一轮原文，共6个版本。未根据保留组的真实模型答复调试，因为目前尚无真实答复。如果以后据其结果改提示词或逻辑，须换新场景复测。

模型只收到原话、身份/时间元数据和必要系统提示；`review` 评阅要点不输入模型，也不调用模型自评分。

`app.runtime.handle → capture → tick → briefingMaterial → 生成器` 使用实际代码。普通闲聊应答替换，收件人为测试替身。绝不调用 `app.start()` 或连接企业微信。模拟 ACK 丢失后重试，检查不提前推进、不开新模型调用、无新增不重复发。只推进秘书时钟，接收时间仍来自真实 `Date.now()`；不声称验证了多日边界。

## Mac 一次运行

解压独立实验包后运行：

```bash
bash experiments/secretary/run-mac.sh
```

默认只读取已找到的运行目录 `~/Downloads/ojj-qq-agent-codex-wecom-integration` 中模型配置；也可传目录作第一个参数。目录不匹配时弹出选择器。模型是否与线上相同需核对结果 manifest，不从目录名称推断线上版本。

脚本优先复用上次下载的官方 Node 24.22.3，找不到则独立下载并核对官方 SHA256，不修复或替换 Homebrew Node。脚本兼容 Mac Bash 3.2，已移除导致 `model_env_args[@]: unbound variable` 的空数组展开。

顺序是开发组原版 → 开发组升级版 → 保留组原版 → 保留组升级版。全部仅向模型 API 发请求，收件人仍为测试替身。生成/校验错误保留并继续；模型请求错误会暂停剩余场景和批次，避免持续联网失败。结束时打开报告并在Finder选中自动打好的结果包。

续跑时传入运行目录与上次结果目录：`bash experiments/secretary/run-mac.sh /absolute/runtime /absolute/previous-results`。只有完整成功且源码/场景/模型一致的版本被复用，未完成的才请求模型；所有旧文件保持不变。单独运行时使用 `--resume-from /absolute/previous-batch`。实验请求上限统一180秒，可用 `--request-timeout-ms` 调整（两算法应相同），不改变生产设置。记录底层错误代码，不记录密钥或代理地址。

先看 `comparison.md`。每个子目录还保留 `review.md`、`manifest.json`、`*-calls.json`（两阶段请求/回复、结构重试、耗时、模型返回usage）、每个场景的原话/转告/档案/来源。输出目录唯一，不覆盖以前结果；文件不含模型密钥。人工逐句评重要的先讲、更正与不确定性、一遍听懂，再比较三种变体，不汇总成一个掩盖问题的总分。

## 云端命令

```bash
node scripts/experiment-secretary.mjs --algorithm baseline --split dev --out tmp/new-comparison/baseline-dev
node scripts/experiment-secretary.mjs --algorithm upgraded --split dev --out tmp/new-comparison/upgraded-dev
node scripts/experiment-secretary.mjs --algorithm baseline --split holdout --out tmp/new-comparison/baseline-holdout
node scripts/experiment-secretary.mjs --algorithm upgraded --split holdout --out tmp/new-comparison/upgraded-holdout
node scripts/compare-secretary.mjs tmp/new-comparison
```

已有安全加载的模型配置时，追加 `--live --config /absolute/runtime/config.json`。没有 `--live` 时明确标为 `wiring-only, NOT model answers`，替身只实现固定结构，无语言理解能力，不可作为质量示范。

## 2026-11-20 验证状态

- 修改前的9个开发版本替身输出保存在 `tmp/pre-upgrade-wiring-dev`。
- 升级后137项代码测试全部通过，0失败/0跳过。其中9项新增测试覆盖引文/更正/重点引用校验、分阶段重试、接收人变更和校验的语义边界。
- 原版/升级版各15个场景版本，共30次实验路径全部通过，保存在 `tmp/upgrade-comparison`；都是替身接线验证。
- 云端无模型密钥，无法直接取得新模型答复。随后用户回传首次Mac真实结果：原版开发9/9、升级开发5/9完成，其余16个均在模型请求层失败，保留组尚未进入本轮测试。具体原话/转告、失败原因与修复见 [MAC-RESULTS-20261120.md](MAC-RESULTS-20261120.md)，完成数不是质量分数。
- Mac 正在运行的机器人未更新，未验证真实企业微信收件；原汽配114题的成绩不转移为汇报质量成绩。
