# 两层 Agent 架构

当前默认执行编排已改为[单主 Agent 与受控工作流](SINGLE-AGENT-WORKFLOWS.md)。以下内容记录 `architecture=multi` 回退模式的设计；开启开关且未指定架构时使用新的单主 Agent。

消息经过现有访问白名单、消息合并和媒体预处理后，进入以下流程：

```text
文字 / 图片 / 文件 / 语音 / 视频
             ↓
现有适配器：文件提取、图片描述、ASR、视频抽帧
             ↓
第一层 IntentRecognizer
  用户指令与附件证据分离 → 用户目标 / 专业角色 / 追问
             ↓
第二层 AgentManager
  拆分任务 → 校验依赖 → 专业 Agent 执行 → 汇总
             ↓
ReplySender + 原有文档/歌曲后台任务
```

此版本在 `Brain.respond` 的边界渐进接入。不是将所有入口业务重写成 Agent。
多角色任务由 Manager 生成计划，单角色任务省略规划请求。
专业 Agent 通过受限工具列表执行；不能递归创建子 Agent。
现阶段按依赖顺序串行执行，避免现有共享工具状态的并发问题。

## 启用与回退

在实际使用的 JSON 配置中添加（配置路径可由 `QQBOT_CONFIG` 指定）：

```json
{
  "chat": {
    "agents": {
      "enabled": true,
      "maxSteps": 4,
      "maxToolCalls": 8,
      "maxRounds": 3,
      "timeoutMs": 120000
    }
  }
}
```

通过控制台配置接口更新可热生效；手工修改文件后重启。
设为 `false` 恢复旧 Brain 工具循环。默认关闭，便于逐步推广。
Manager 接管的请求不会再执行入口中的绘图、文档、歌曲等补执行兜底。
失败后不会自动重跑旧流程，避免重复生成或重复发送。

## 能力归属与迁移边界

| 能力 | 实现 | 当前路径 |
| --- | --- | --- |
| 对话、时间、会话记忆、表情 | conversation | 专业 Agent，可使用 get_time/search_history/find_media/remember/remember_global/send_sticker |
| 网页与历史检索 | research | 专业 Agent；复用 search_web/search_history/find_media |
| 汽修配件检索 | automotive | 专业 Agent；lookup_part/search_web，要求说明适配不确定性 |
| PPT/Word/Excel | document | 专业 Agent 排队；已有后台任务生成并交付；上游资料通过 job.context 传入 |
| 绘图、表情 | image | 专业 Agent；draw_image/send_sticker |
| TTS、哼唱、原创歌 | audio | 专业 Agent；send_voice/sing/sing_song |
| 文件下载/文字提取/Office 内嵌图片 | files.js + index.js | 输入适配层；保持原来的格式支持与读取限制 |
| 语音识别、视频抽帧 | asr*.js/media.js + index.js | 输入适配层；识别后的语音可作为用户指令；仍需额外依赖/凭据 |
| 曲库翻唱、纠正与引用音频 | understanding.js/library.js/cover.js + index.js | 开启 Manager 时先结构化理解、任务更新、只读核验；旧直接路由仅在关闭开关时使用 |
| QQ 空间、传话 | qzone.js/relay.js | 保留原有定时任务、显式命令及旧模式；新 Agent 工具集不开放这些外部操作 |
| 管理命令 | index.js handleCommand | 显式命令继续走原路径，不经过模型分类 |
| 权限、限流、发送、后台任务 | index.js/onebot.js/reply.js | 公共基础设施，不封装为会自行决策的 Agent |

注册表是显式白名单；新增上游工具不会自动获得执行权限。
`remember_global` 等工具仍保留原代码的主人身份校验。
检索工具目前继承原实现的结果格式，网页搜索未保留完整 URL；不要声称实现了完整来源审计。

## 关键约束

- 意图分类只接收用户指令、截断后的附件证据与媒体种类，不接收本地附件路径。
- 图片描述按用户任务提取事实；当前最多识别前三张图片，沿用旧读取限制。
- 专业 Agent 只获得当前任务和显式依赖结果；只有对话角色获得最近八条对话。
- 意图与计划执行前做结构校验，拒绝未知角色、重复 ID、前向依赖、环和超限步骤。
- 工具调用在执行时再次校验角色权限，相同名称和参数在单任务内复用结果。
- 工具总次数、每个角色的轮次和任务步骤有硬上限；时间预算在阶段边界检查，模型请求使用剩余预算。旧工具和模型内部重试尚不支持统一取消，因此不是严格的整任务墙钟超时。
- 依赖失败会阻止下游执行。旧工具用自然语言返回错误，目前用保守文本标记识别部分失败；后续应逐项迁移为结构化结果。
- 附件和搜索内容在提示词中标记为数据，不能将这种提示约束当成完整的提示注入防护。
- 文档/歌曲的“已排队”与“已完成”分开描述。Manager 的 completed 表示调度轮次完成，不表示后台产物已生成。
- 每个任务有 ID、步骤状态和工具记录；QQ 路径日志记录状态摘要，控制台测试返回 orchestration。尚无持久任务数据库、跨进程幂等或断点恢复。
- 控制台测试沿用原有预览行为，不执行文档/歌曲后台交付；完整交付通过 QQ 消息路径验证。

## 本地验证

```bash
node --test --test-concurrency=1 tests/*.test.js
```

单元测试覆盖多模态输入分离、计划校验、权限限制、跨 Agent 资料传递、追问、去重、预算和失败依赖。
集成测试启动真实机器人进程，使用本地 HTTP 模型模拟器和 OneBot WebSocket 服务，验证带图输入、意图识别、绘图 Agent、真实 mock 图片生成和唯一发送，同时验证关闭开关后的旧流程。
这些测试不调用真实模型，不发送真实 QQ 消息，不能证明真实模型的规划质量。

## 跟随上游更新

1. 保持 `src/agents/` 的模型编排与现有实现分离，优先在 registry 调整工具归属。
2. 更新上游后比较 createTools 的 specs、run 参数及返回格式，以及 Brain/入口的接入位置。
3. 运行上述测试，重点检查媒体输入、队列数据和新旧路径不会重复执行。
4. 新能力先补适配器和测试，再加入注册表。翻唱已使用专用适配器；外部发布仍待逐项迁移。

未增加生产依赖；部署时需显式开启管理模式，并在实际模型和 OneBot 环境中联调。

## 共享自我状态

现已接入身份、能力状态及空间发布行动记录，详见 [SELF-STATE.md](SELF-STATE.md)。查询已发生的空间动态走 conversation，不要求开放新的发布工具；Manager 仍未接管空间发布调度。

## 分阶段理解（第二版）

第一层现已升级为语义理解、任务更新和执行前校验，详见 [INTENT-UNDERSTANDING.md](INTENT-UNDERSTANDING.md)。
