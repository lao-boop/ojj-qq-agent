# ojj · 小鲸鱼 QQ Agent

一个跑在 QQ 上的拟人化 Agent：会聊天、有长期记忆、能发语音、唱歌、翻唱、画图、做 PPT/Word/Excel、发 QQ 空间动态，还带一个汽修配件识别模块。

底层用 **DeepSeek**（OpenAI 兼容接口），QQ 协议端用 **SnowLuma / NapCat**（OneBot v11），图像用 **FLUX**，语音合成用 **Edge TTS**，变声用 **RVC**，语音识别用 **faster-whisper**（本地）或 **WhisperX**（云端）。

> 这是私人助理型项目：人格、记忆、语气都按“像朋友一样聊天”来设计，不是客服机器人。

---

## 功能一览

| 模块 | 能力 | 代码 |
| --- | --- | --- |
| 人格与说话方式 | 分条短消息、口语化、动作描写、不暴露 AI 身份 | `assets/persona.default.md`、`src/brain.js` |
| 长期记忆 | 全量聊天记录、摘要、关键词召回、同义词扩展、文件收发记忆 | `src/memory.js`、`src/media-log.js` |
| 表情包 | 按情绪分类挑图发送，支持“斗图”触发 | `src/tools.js`（`send_sticker`） |
| 语音 | Edge TTS 合成 + SILK 转换，可发语音条或文件 | `src/tts.js`、`src/media.js` |
| 唱歌 | 本地曲库点歌、按歌词定位、截取、变声翻唱 | `src/library.js`、`src/cover.js`、`src/asr.js` |
| 原创歌曲 | ACE-Step 生成（词+曲+唱），自动 RVC 变声 | `src/song.js` |
| 翻唱用户音频 | QQ 语音/音频文件 → 转码 → RVC → 回发 | `src/index.js`（`runCoverJob`） |
| 画图 | FLUX 出图，提示词翻译 + 出图后质检重画 | `src/image.js`、`src/tools.js` |
| 文档生成 | PPT（图表/卡片/配图）、Word、Excel | `src/office.js`、`scripts/build_office.py` |
| QQ 空间 | 定时发说说（配图）、自动回评论、评论去重 | `src/qzone.js` |
| 传话 | 白名单好友 ↔ 主人双向即时转达 | `src/relay.js` |
| 汽修配件 | 24 类配件库检索、追问边界、结构化评测 | `src/parts.js`、`scripts/auto_repair_eval.mjs` |
| Web 控制台 | 状态、日志、会话、人格编辑、配置修改 | `src/server.js`、`public/index.html` |

---

## 架构

```
QQ ←→ SnowLuma/NapCat (OneBot v11, WebSocket)
        │
        ▼
   src/onebot.js  ── 事件解析 / 发送
        │
        ▼
   src/index.js   ── 入口：消息路由、意图兜底、后台任务
        │
        ├─ src/brain.js    ── 人格提示词 + 工具循环 + 分条回复
        │     ├─ src/llm.js       DeepSeek 调用（含推理模型兼容）
        │     ├─ src/memory.js    会话/摘要/召回
        │     └─ src/tools.js     工具集（画图、语音、唱歌、文档、记忆、传话…）
        │
        ├─ src/image.js    ── FLUX / 硅基流动 / Pollinations
        ├─ src/tts.js      ── Edge TTS
        ├─ src/cover.js    ── RVC 变声
        ├─ src/song.js     ── ACE-Step 写歌
        ├─ src/asr.js      ── WhisperX 逐字对齐（歌词定位 / 云端转写）
        ├─ src/asr-local.js── 本地 faster-whisper 服务客户端
        ├─ src/office.js   ── PPT/Word/Excel
        ├─ src/qzone.js    ── QQ 空间
        └─ src/server.js   ── 控制台 HTTP
```

---

## 快速开始

### 1. 环境

- Node.js ≥ 20
- Python ≥ 3.9（文档生成、SILK 解码、本地 ASR 需要）
- ffmpeg（音频处理）
- 一个 QQ 小号 + [SnowLuma](https://github.com/SnowLuma/SnowLuma) 或 NapCat

### 2. 安装

```bash
git clone https://github.com/<your-name>/ojj-qq-agent.git
cd ojj-qq-agent
npm install
```

Python 依赖（按需）：

```bash
pip install python-docx python-pptx openpyxl edge-tts faster-whisper pilk
```

### 3. 配置

复制示例配置：

```bash
cp config.example.json config.json
```

最少要填：

| 字段 | 说明 |
| --- | --- |
| `llm.apiKey` | DeepSeek API Key |
| `llm.model` | 主模型，默认 `deepseek-v4-pro` |
| `llm.visionModel` | 视觉模型，默认 `deepseek-flash` |
| `onebot.wsUrl` | OneBot WebSocket，如 `ws://127.0.0.1:3001` |
| `onebot.accessToken` | OneBot token |
| `image.apiKey` | Replicate token（出图/唱歌/变声都要） |
| `song.token` | Replicate token（可与上面相同） |
| `library.dir` | 本地音乐目录（点歌用） |
| `access.ownerQQ` | 主人 QQ（传话、全局记忆用） |

### 4. 启动

```bash
npm start
```

控制台默认在 `http://127.0.0.1:3010`，首次启动会生成 `data/` 与 `data/persona.md`。

---

## Mac 多模态接入

支持独立视觉接口、MiniMax 国内/国际语音输出、本地语音识别、扫描 PDF 前 3 页渲染，以及 Mac 与 NapCat Docker 共享附件路径映射。使用本地配置向导，保留现有 QQ 和 DeepSeek 配置：[安装与验证步骤](docs/MAC-MULTIMODAL.md)。

## 多 Agent 与意图理解

可选的两层流程：多模态语义理解 → 会话任务更新与执行前校验 → Manager 调度专业 Agent。
支持文档、图像、语音、资料、汽修和记忆操作的权限约束，并对曲库翻唱做准确匹配。
空间发布记录会提供给有权限的聊天上下文，区分计划、执行中、成功、失败及结果未知。

在实际 `config.json` 的 `chat` 中添加 `"agents": { "enabled": true }` 并重启即可启用；设为 `false` 回退旧流程。默认不开启，更新代码不会自动改变已有运行模式。

- [Agent 架构与迁移边界](docs/AGENT-ARCHITECTURE.md)
- [意图理解与操作约束](docs/INTENT-UNDERSTANDING.md)
- [身份、能力与行动记录](docs/SELF-STATE.md)

验证命令：`node --test --test-concurrency=1 tests/*.test.js`。测试使用模拟模型和 OneBot，真实模型效果需另行联调；运行中任务暂不能可靠取消，任务上下文不跨进程重启保留。

---

## 人格与说话方式

人格文件在 `data/persona.md`（首次启动从 `assets/persona.default.md` 复制）。

几个关键设计：

- **分条**：模型按换行/句号写多条，`src/reply.js` 拆成多条短消息发送
- **不暴露 AI**：提示词明确禁止提“模型/训练/提示词”
- **动作描写**：允许括号写动作，但限制频率
- **兜底机制**：说要画图/发语音/唱歌却没调工具时，`src/index.js` 会强制补一次，避免“只说不做”

改人格不需要动代码，编辑 `data/persona.md` 即可，下一条消息生效。

---

## 长期记忆

三层：

1. **会话记录**（`data/sessions/*.json`）
   - 按 `chatKey` 隔离（`private:QQ` / `group:群号`）
   - `storeAllTurns: true` 时不裁剪历史
   - 超过阈值生成摘要
2. **召回**（`src/memory.js`）
   - 关键词 + 二元组余弦相似度
   - 用 `deepseek-flash` 做同义词扩展
   - `search_history` 工具让模型主动查旧对话
3. **文件记忆**（`src/media-log.js`）
   - 记录收发过的图片、音频、视频、文档
   - 文档存前 200 字摘要
   - 每轮注入最近 10 条；`find_media` 工具可按关键词检索全部记录

另有：

- **全局公开记忆**（`data/memory-global.json`）：关于主人/机器人的公开信息，所有会话可见
- **传话队列**（`data/relay.json`）：白名单好友 → 主人，主人 → 好友，均即时推送

---

## 表情包

- 把表情包按分类放进 `data/stickers/<分类>/`（happy、sad、angry、tired、shy、eating、surprised、affection）
- 启动时扫描成分类表
- 模型用 `send_sticker(category)` 发图；对方明确说“表情包/斗图”时，`src/index.js` 会兜底强制发一张

---

## 点歌 / 翻唱 / 创作

### 点歌（本地曲库）

- 支持 `歌手-歌名`、`歌名-歌手` 两种命名
- 打分：完全匹配 100，歌手过滤 ±15
- 支持“从某句开始唱”：WhisperX 逐字对齐定位歌词时间点
- 截取 → RVC 变声 → 回发语音/文件

### 翻唱用户音频

```
QQ 语音（SILK）→ pilk 转 wav → ffmpeg 转 16k mp3 → RVC
```

触发方式：

- “翻唱我刚刚唱的”
- “我怎么唱你就怎么唱”（模仿唱法）
- 直接发音频 + “翻唱”
- “再来唱 / 再唱一遍”（复用上一次音频）

### 原创歌曲

- `sing_song` 工具：ACE-Step 写词曲并演唱
- 生成后自动 RVC 变声成机器人音色（可关）
- 音符不够时退回哼唱（`src/music.js`）

---

## QQ 空间

`src/qzone.js`：

- 每 N 小时自动发说说（可配图）
- 每天条数上限
- 定时拉评论并回复，回复会带记忆上下文
- 去重键是 `tid:commentId`（comment_id 只在单条说说内唯一，这是个容易踩的坑）

---

## 文档生成

- `make_ppt`：先批量生成大纲 JSON（避免长输出截断），再调 `scripts/build_office.py`
- 版式：封面、章节页、要点页、卡片页、图表页、结束页
- 配图：默认“除封面封底外最多 2 页无图”，FLUX 生成，失败重试
- 图表：柱状/折线/饼图，显式配色 + 数据标签
- `make_docx` / `make_excel` 同理

---

## 汽修 Agent

### 能做什么

- 24 类配件分类库（`data/knowledge/parts_catalog.jsonl`）
- 按名称/俗称/英文名/外观线索检索
- 明确“能确认类别 ≠ 能确认适配”，缺车型/位置/OE 号时追问
- 多模态输入：配件照片、车辆照片、VIN 采集卡、维修单、聊天截图、语音

### 评测

`scripts/auto_repair_eval.mjs` 是一个离线评测脚本：

```bash
export AUTOREPAIR_DIR=/path/to/auto_repair_multimodal_v1
node scripts/auto_repair_eval.mjs --split=dev
node scripts/auto_repair_eval.mjs --split=test
```

它做四件事：

1. 图片 → 结构化文字（VIN 逐位读、遮挡位 `?`、车辆划痕判断），带缓存
2. 语音 → WhisperX 转写，带缓存
3. 拼接 `agent_prompt + 配件库 + 规则`，要求模型输出 JSON
4. 调用数据集自带 `tools/evaluate.py` 打分

详细说明见 [docs/AUTO-REPAIR.md](docs/AUTO-REPAIR.md)。

> 数据集本身不随仓库分发，请自行准备并遵守其许可。

---

## Web 控制台

`http://127.0.0.1:3010`（可在配置里改端口和口令）：

- 连接状态、运行时长、当前任务（干活中）
- 实时日志
- 会话浏览/删除
- 人格在线编辑
- 配置热更新
- 测试对话

---

## 目录结构

```
src/            核心代码
assets/         默认人格
scripts/        Python 辅助脚本 + 评测脚本
public/         控制台前端
data/knowledge/ 配件库
docs/           文档
```

运行时生成（不入库）：`data/sessions`、`data/files`、`data/images`、`data/audio`、`data/models`、`config.json`。

---

## 隐私与合规

- 本项目的记忆、文件记录都保存在本地 `data/`，不会上传到第三方（除模型 API 必需的内容）
- 请不要把 `config.json`、`data/`、日志提交到公开仓库（`.gitignore` 已排除）
- 翻唱/变声仅用于私人娱乐；公开发布请自行确认版权
- QQ 机器人请遵守腾讯相关规定，建议只用小号

---

## License

MIT
