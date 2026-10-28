# 小鲸鱼 · QQ 机器人

一个能自己聊天的 QQ 机器人：DeepSeek 当大脑，人格、记忆、表情、分条说话、会画图，自带本地控制台。
不需要 GPU，不依赖别的框架，QQ 侧通过标准 OneBot v11 接入（NapCat / SnowLuma / Lagrange 都行）。

```
QQ 好友/群消息 ──► NapCat / SnowLuma（OneBot v11 WS）──► 本程序 ──► DeepSeek
                                                          │
                                                          └──► 图片（出图接口）/ 本地表情包
```

## 已经做好的能力

- **像人一样聊天**：一次回 1~3 条短消息，分条发送、中间有停顿；不用 Markdown、不客服腔、不每句挂 emoji。
- **人格可改**：人格写在 `data/persona.md`，控制台里改完保存就生效，不用重启。
- **记得住**：每个私聊/群独立记忆，长对话自动压成摘要，重要的事用 `remember` 工具长期记住。
- **会画图**：被要求画东西时真的出图并发送（出图后端可换，见下文），画之前会先说一句“等我一下”。
- **会发语音**：Edge TTS + 晓伊音色（免费、不用 key），你说“说句话/发语音”它就发一条 QQ 语音条。
- **会读文件**：QQ 发来的 docx / pptx / xlsx / pdf / txt 会把文字抽出来读，然后按内容聊（读不出来也会回你，不会装死）。
- **会发表情包**：内置 551 张 ATRI 表情（15 类情绪），按对话情绪自己挑，也能 `/sticker happy` 指定；**对方发表情包来斗图时，它会回一张**，还会把表情包上的字（`mface` 的 text）读进上下文。
- **会看图片**：对方发来的图会先用视觉模型（deepseek-flash）描述成文字再进上下文；**引用一张图说“看看这个”也能识别**，多图会分开描述，图里有文字会读出来。
- **群聊有分寸**：默认只在被 @ 或提到唤醒词（小鲸鱼 / 鲸鱼 / 小鱼）时接话，也可以设一个很低的随机接话概率。
- **白名单 + 限流**：只服务你允许的 QQ/群；每个会话每分钟最多回几条。
- **管理指令**：`/help` `/status` `/reset` `/draw 画一只猫` `/model deepseek-v4-pro`。
- **本地控制台**：`http://127.0.0.1:3010` —— 看连接状态、在线测试聊天、改人格/配置、翻会话和日志。
- **不用 QQ 也能测**：`node scripts/e2e.js` 会起一个模拟的 OneBot 服务端，把“收消息 → 回复 → 画图 → 发图”整套跑一遍。
- **会陪你玩 Minecraft**：内置 mineflayer 客户端，能进 Java 版服务器，跟着你走、挖方块、合成工具、打怪、睡觉；长任务可以“挖 10 个木头，挖完回来”。
- **记忆会检索**：会话全量保存，每轮带最近 60 条 + 召回 10 条（关键词 + 字级向量），还能自动把行程/考试/偏好记成笔记。
- **会做文档**：PPT / Word / Excel，先用 DeepSeek 生成大纲，再用 python-pptx / python-docx / openpyxl 排版。
- **会写歌、翻唱、变声**：ACE-Step 写歌，RVC 换成自己的音色，本地曲库点歌后自动截取。
- **语音转文字**：本地 faster-whisper 常驻服务，QQ 语音 2~3 秒转写；粤语会自动换模型。

## 快速开始

> 需要 Node.js 20+。本机已经装好依赖；换电脑时先 `npm install`。

1. **填密钥（推荐用 `.env`）**
   在项目根目录新建 `.env`：

   ```
   DEEPSEEK_API_KEY=sk-你的key
   REPLICATE_API_TOKEN=r8_你的token
   ONEBOT_ACCESS_TOKEN=OneBot那边的token
   CONSOLE_TOKEN=给控制台设的密码
   ```

   `config.json` 里对应的密钥字段留空即可，启动时会自动用环境变量覆盖。
   不建 `.env` 也可以，直接把 key 填进 `config.json → llm.apiKey`。
2. **接 QQ**（二选一，见下一节）
   装好 SnowLuma（本文验证过的方案）或 NapCat，用它登录一个 QQ 小号，并开启 OneBot 的 WebSocket 服务（默认 `127.0.0.1:3001`）。
3. **启动**
   双击 `start.bat`（或 `node src/index.js`）。控制台显示“已连接”就成功了，去 QQ 给小号发条消息。

`start.bat` 会自己找 Node（PATH、Program Files、本机 `.workbuddy` 里的 Node 都试一遍）。

## 接 QQ：选一种

> 两者都是 OneBot v11 实现，本程序代码不依赖具体用哪个。本仓库的示例与截图是在 **SnowLuma** 上验证的；NapCat 同样可用，只是步骤略有不同。

### 方式一：NapCat（社区最常用，可替换）

1. 电脑上先装好 QQ（QQNT），并**用一次你的 QQ 小号登录过**，让客户端准备好运行环境。
2. 到 [NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases/latest) 下载 `NapCat.Shell.zip`（约 36MB），解压到比如 `C:\NapCat`。
3. 双击目录里的 `launcher.bat`。它会拉起 QQ 并注入 NapCat；浏览器打开 `http://127.0.0.1:6099`，用启动日志里的 token 登录。
4. 在 NapCat 的 WebUI 里扫码登录**小号**。
5. 进「网络配置」→ 新建「WebSocket 服务器」：
   - 地址 `127.0.0.1`，端口 `3001`
   - token 可以不设；设了就把同样的值填到 `.env` 的 `ONEBOT_ACCESS_TOKEN`（或 `config.json → onebot.accessToken`）
6. 回到本项目，确认 `onebot.wsUrl` 是 `ws://127.0.0.1:3001`，启动。

> ⚠️ NapCat 会接管它启动的那个 QQ 客户端。用小号时，主号建议在手机上或另一台设备上待着；同一台电脑上两个 QQ 号同时在线需要额外折腾（复制一份 QQ 目录、改端口），不建议新手尝试。

### 方式二：SnowLuma（视频里同款，本仓库验证过的方案）

> SnowLuma 的 EULA 规定安装、启动、扫码要由使用者自己完成，所以这一步得你本人操作；本程序只负责连它的 OneBot。

1. 到 [SnowLuma Releases](https://github.com/SnowLuma/SnowLuma/releases/latest) 下载 `SnowLuma-v*-win-x64.zip`，解压后双击 `launcher.bat`。
2. 打开日志里打印的 WebUI 地址（默认 `http://127.0.0.1:5099`），初始密码在启动日志里。按引导：同意条款 → 设密码 → 注入 QQ 进程 → 扫码登录小号。
3. 在 WebUI 里开启 **WebSocket 服务端**（默认端口 3001；HTTP API 默认 3000，本程序用不到）。
4. 把 `config.json → onebot.wsUrl` 填成 `ws://127.0.0.1:3001`，有 token 就一起填。

### 方式三：已经有一个 OneBot 实现

Lagrange.OneBot 之类的都行，只要是 OneBot v11 的**正向 WebSocket**（本程序作为客户端去连）：
把 `onebot.wsUrl` 指向它即可。

## 第一次用，建议这样配

1. 控制台 → **配置**：
   - `管理员 QQ`：填你自己的主号（能用 `/status`、`/draw` 等指令）
   - `允许私聊的 QQ`：先填你主号
   - `允许的群号`：先把要用的群填进来（不填就不理群消息）
2. 控制台 → **在线测试**：发一句“在吗”，看看人格和速度是否满意。
3. 控制台 → **人格**：不满意就直接改提示词，保存即生效。
4. 去 QQ 上私聊小号发消息；第一次回得慢一点是正常的（模型 + 打字延迟）。

## 控制台

启动后打开 <http://127.0.0.1:3010>（只监听本机；想加密码就在 `config.json` 里设 `console.token`）。

| 页面 | 能干什么 |
| --- | --- |
| 概览 | 连接状态、登录账号、模型、收发统计、运行时长、最近会话 |
| 人格 | 编辑 `data/persona.md`，保存即生效 |
| 配置 | 改 OneBot 地址、模型、白名单、群聊规则、出图后端 |
| 在线测试 | 不经过 QQ，直接和机器人对话（同一套人格和记忆） |
| 会话 | 翻每个人的聊天记录、看摘要和记忆、清空某个会话 |
| 日志 | 最近 500 行运行日志 |

## 配置说明

`config.json`（控制台保存时也会写这里）：

| 字段 | 说明 |
| --- | --- |
| `onebot.wsUrl` | OneBot 正向 WebSocket 地址，默认 `ws://127.0.0.1:3001` |
| `onebot.accessToken` | OneBot 的 access token，没设留空 |
| `llm.apiKey` / `llm.baseUrl` | DeepSeek（或任何 OpenAI 兼容）接口 |
| `llm.model` | 主对话模型，默认 `deepseek-v4-pro` |
| `llm.visionModel` / `llm.helperModel` | 看图、翻译提示词用的便宜模型，默认 `deepseek-flash` |
| `chat.maxBubbles` | 一次回复最多拆成几条消息 |
| `chat.splitDelayMs` / `firstDelayMs` | 分条停顿、第一句之前的“打字”延迟（毫秒区间） |
| `chat.historyTurns` | 上下文里带多少轮对话 |
| `chat.summaryTriggerChars` | 历史超过多少字开始压摘要 |
| `chat.group.replyOnAt` | 群里是否必须 @ 才回 |
| `chat.group.wakeWords` | 群里提到这些词也算叫它 |
| `chat.group.chanceReply` | 没被叫到时随机接话的概率（0 就是从不） |
| `chat.rateLimit.perChatPerMinute` | 每个会话每分钟最多回几条 |
| `access.adminQQ` | 管理员 QQ（能用管理指令） |
| `access.privateAllow` / `access.groupAllow` | 私聊 / 群白名单 |
| `access.allowAllWhenEmpty` | 白名单为空时是否放行所有人。**交付时这项是 `true`**（小号刚建、还没人知道它），你填上白名单后就自动只认白名单；想立刻收紧就把它改成 `false` |
| `image.enabled` / `image.provider` | 是否画图、用哪个后端 |
| `image.apiKey` / `image.baseUrl` | 出图后端的 key 和地址 |
| `tts.enabled` | 是否允许发语音 |
| `tts.voice` | 音色，默认 `zh-CN-XiaoyiNeural`（晓伊）；也可写别名 |
| `tts.rate` / `tts.pitch` | 语速 / 音调，如 `+10%`、`-5Hz` |
| `tts.pythonPath` | 指定装了 `edge-tts` 的 python，留空自动找 |
| `console.port` | 控制台端口，默认 3010 |
| `console.token` | 控制台访问令牌，留空则本机免密 |

## 出图：三种后端

| 后端 | 要不要 key | 限制 / 说明 |
| --- | --- | --- |
| `pollinations`（默认） | 不用 | 免费、免注册；**同一 IP 45 秒只能出一张**、最大 768×768、偶尔 503。程序会自动重试，失败会如实告诉对方“等会儿再画”。 |
| `siliconflow` | 要 | 硅基流动，FLUX.1-schnell 有免费额度，速度快、质量明显更好，**推荐长期用**。注册后在控制台填 key 即可。 |
| `openai` | 要 | 任何 OpenAI 兼容的 `/images/generations` 接口 |
| `mock` | 不用 | 本地固定图，给自测用，不消耗额度 |

提示词处理：中文会先用 `helperModel` 翻成英文 tag（主体保留原意），再发给出图接口；翻译失败就退回原文。主模型一般会直接用英文写 prompt，翻译只是兜底。

`pollinations` 出图本身要 10~60 秒（看它服务器心情），所以聊天里它会先回一句“等我一下，我画给你”，画完再把图发出来。想快就换 `siliconflow`。

## 常用指令（管理员私聊）

```
/help            看指令
/status          连接、模型、收发统计
/reset           清空当前会话记忆
/draw 画一只猫    直接出一张图
/say 你好呀       发一条语音（晓伊）
/sticker happy    发一张表情包（也可写 /sticker 生气）
/model deepseek-v4-pro   切换模型
```

## 自测

```bash
node scripts/e2e.js
```

会临时起 mock OneBot（端口 3199）和机器人，发三条消息（聊天、情绪、画图），确认收到回复和图片后退出。
不需要 QQ，不消耗出图额度，只消耗少量 DeepSeek token。想手动看过程：

```bash
node src/mock-onebot.js --port 3101 --qq 10001 --group 90001 --message "在吗||给我画一只猫"
# 另开一个窗口，把 config.json 的 wsUrl 指到 ws://127.0.0.1:3101，再 node src/index.js
```

## 目录结构

```
qq-bot/
  start.bat              启动脚本
  config.json            你的配置（含 key，别外传）
  config.example.json    配置模板
  assets/persona.default.md  默认人格（首次运行复制到 data/persona.md）
  src/
    index.js             入口：连接、白名单、群聊判定、指令、热更新
    brain.js             组装提示词、工具循环、分条
    memory.js            会话记忆与摘要
    llm.js               DeepSeek 调用（含重试）
    onebot.js            OneBot v11 WebSocket 客户端
    reply.js             拟人化发送（延迟、分条、语音、图片）
    tools.js             draw_image / send_voice / get_time / remember / send_sticker
    image.js             出图后端
    tts.js               语音合成（调用本机 Python 的 edge-tts）
    server.js            控制台 HTTP + API
    mock-onebot.js       模拟服务端（自测用）
  public/index.html      控制台页面
  data/
    persona.md           当前人格（可改）
    sessions/            每个会话的记忆
    images/              画出来的图
    audio/               合成出来的语音
    stickers/<分类>/      可选：放表情包，按分类建文件夹
    logs/bot.log         运行日志
  scripts/e2e.js         端到端自测
```

## 好友申请 / 入群邀请

- **好友申请**：默认自动通过（`access.autoAcceptFriend: true`），通过后发一条 `access.greeting` 欢迎语（留空就不发）。
- **入群邀请**：默认**不**自动通过（`access.autoAcceptGroupInvite: false`），免得被陌生人拉进乱七八糟的群；需要的话在控制台打开。
- 通过之后对方发消息会不会回，取决于白名单：白名单为空且 `allowAllWhenEmpty: true` 时谁都能聊；一旦填了 `adminQQ` / `privateAllow`，就只认名单里的人。
- 好友申请、入群邀请的日志都会打在控制台「日志」里（`已自动通过好友申请：xxx（附言：yyy）`）。

## 文件

QQ 里直接发文件（私聊/群都行）会被当成一条消息处理：

| 格式 | 能力 |
| --- | --- |
| `.docx` | 段落 + 表格文字 |
| `.pptx` | 每页文字 |
| `.xlsx` / `.xlsm` | 每个工作表的单元格 |
| `.pdf` | 逐页文字（扫描件没 OCR，读不出） |
| `.txt` / `.md` / `.csv` / `.json` / 代码文件 | 直读，自动试 utf-8 / gbk |

- 一条消息最多处理 2 个文件，单文件上限 20MB，抽出来的文字截前 6000 字进上下文
- **`.doc` / `.xls` / `.ppt` 老格式不支持**，会让对方另存为 docx/xlsx/pptx——不是装死，是会明确回一句
- 依赖本机 Python（和语音共用），库是 AstrBot 那个环境里的 python-docx / python-pptx / openpyxl / pypdf
- 抽取脚本：`scripts/extract_text.py`，下载的文件落在 `data/files/`

## 翻唱 / 变声（Replicate RVC）

把一段人声（或整首歌）换成目标声线，内部做人声分离再变声。

- 用法：发一段语音或 mp3 给机器人，然后说「**翻唱一下**」「变个声」；也可以发 `/cover`
- 模型：`zsxkib/realistic-voice-cloning`，内置声线：`Squidward / MrKrabs / Plankton / Drake / Vader / Trump / Biden / Obama / Guitar / Violin / CUSTOM`
- 想用自己的音色：把训练好的 `.pth` 打包成可下载直链，填 `voice.customModelUrl`，`rvcModel` 会自动用 CUSTOM
- 参数：`voice.rvcModel`、`voice.pitchChange`（`no-change` / `male-to-female` / `female-to-male`）
- 限制：`voice.dailyLimit`（默认每会话每天 10 次）；QQ 语音条是 SILK，可能转不了，**建议发 mp3 文件**
- 发送方式：`voice.sendAsVoice`（默认 `true`，≤55 秒直接发语音条；`false` 发文件）、`song.sendAsVoice`（默认 `auto`）
- 版权：翻唱现成歌曲涉及词曲/录音版权，商用场景不要开放给客户

## 识图

对方发图（或引用一张图）时，会先用 `llm.visionModel`（默认 deepseek-flash）把图描述成中文，拼进上下文，主模型再自然地聊内容。

- 支持来源：`http(s)` 链接、`base64://`、`file://`、本地路径、`data:` URL
- 单条最多处理 3 张，多图按「图1 / 图2」分开描述
- 图里的文字会让它读出来（水印、截图、聊天记录都行）
- 识别失败会直说“没看清”，不会瞎编（人格里写死了）
- 引用图片的用法：回复那张图并说「看看这个」「这是啥」，`get_msg` 会把图取出来一起识别

> 一次识别大约多花 3~5 秒、几百 token；图片太大（>8MB）会跳过。

## 哼唱（唱歌）

不依赖任何模型/API，纯代码合成：五声音阶旋律 + 四和弦铺底 + 颤音，**每次旋律都不一样**。

- 触发：QQ 里说「唱首歌 / 哼一段 / 来一句」，或 `/sing`
- 时长：`music.minSeconds` ~ `music.maxSeconds`（默认 18~30 秒随机）
- 纯哼唱，**默认不加任何环境音**；客服场景想要海浪底噪，把 `music.noise` 调到 `0.02~0.04`
- 其他参数：`music.tempo`（默认 84，越小越慵懒）
- 输出 16kHz 单声道 WAV（24 秒约 0.7MB），SnowLuma 会自动转成 QQ 语音条；超过 60 秒建议改发文件

## 语音（Edge TTS）

用的是本机 Python 里的 `edge-tts` 包（免费、不用 key），默认音色 **晓伊**（`zh-CN-XiaoyiNeural`）。

- 依赖：任意装了 `edge-tts` 的 Python。默认会自动找 AstrBot 自带的那个（`%LOCALAPPDATA%\AstrBot\backend\python\python.exe`），找不到就用 PATH 里的 `python`。装包：`python -m pip install edge-tts`
- 触发：QQ 里说「说句话 / 发语音 / 念一下」，模型会调 `send_voice`；也可以直接发指令 `/say 你好呀`
- 换音色：控制台「配置 → 语音」里改，或改 `config.json → tts.voice`。可以写完整名，也可以写别名：`晓伊 / 晓晓 / 云希 / 云健 / 晓梦`
- 语速和音调支持 `+10%`、`-5Hz` 这种格式
- 发出去的是 QQ 语音条：SnowLuma 会把 mp3 自动转成 SILK。一条控制在 60 字以内，太长了像念课文

想让它发表情包：素材放在 `data/stickers/<分类>/` 里（jpg/png/gif 都行），重启后分类会自动出现在工具描述里，模型按情绪挑。可以按语义建分类，例如 happy / approval / angry / sad / confused / surprised / shy / tired / eating / affection / greeting / refusal / teasing / action / reply：

也可以手动发：`/sticker happy`、`/sticker 生气`（支持中文别名）。挑图时会避开这个会话最近发过的 8 张，不会连着甩同一张。

> 表情包素材请使用你有权使用的图片，版权归原作者。

## 密钥放在 `.env`（推荐）

项目启动时会读根目录的 `.env`，用环境变量覆盖 `config.json` 里的密钥字段，所以配置文件可以安全地发给别人。

```
DEEPSEEK_API_KEY=sk-...
REPLICATE_API_TOKEN=r8_...
ONEBOT_ACCESS_TOKEN=...
CONSOLE_TOKEN=...
```

- `.env` 已在 `.gitignore` 里，不会进仓库
- 控制台「配置」页显示的密钥是掩码；改密钥请改 `.env` 后重启
- 不建 `.env` 时，仍然可以直接把 key 写进 `config.json`

## 记忆与检索

| 层 | 存在哪 | 怎么用 |
| --- | --- | --- |
| 会话 | `data/sessions/*.json` | 全量保存；每轮带最近 60 条 |
| 召回 | 同上 | 关键词 + 字级 2/3-gram 向量，取前 10 条 |
| 笔记 | 同上 `notes` | 行程/考试/承诺/偏好会自动记，最多 40 条 |
| 文件 | `data/media-log.json` | 最近 10 条 + `find_media` 检索 |
| 行动 | `data/actions.json`、`mc-actions.json` | 空间动态、Minecraft 行动 |
| 公开 | `data/memory-global.json` | 主人身份、喜好，所有会话可见 |

想让某件事被长期记住，直接说「记住，……」；她会调用 `remember` 写进笔记。

## Minecraft 陪玩

需要 Java 版服务器（支持 1.20 ~ 26.1，靠 mineflayer 的协议支持），在 `config.json` 里配：

```json
"mc": {
  "username": "Xiaojingyu",
  "host": "127.0.0.1",
  "port": 25565,
  "version": "26.1",
  "ownerName": "你的游戏ID"
}
```

然后用 QQ 私聊说「连 127.0.0.1:25565」，她会进服。能做：

- 跟着你走 / 停下 / 走到坐标
- 挖方块（自动换镐/斧/锹）、捡掉落物、放方块
- 合成木板/木棍/工作台/木镐/石镐，缺材料会自己补
- 打 24 格内的怪，6 格内自动反击
- 收庄稼、睡觉、开箱子存取
- 长任务：`去挖 10 个木头，挖完回来`，可查进度、可取消
- 游戏内按 T 直接聊天，游戏里的对话和 QQ 记忆共享

> 服务端建议 `online-mode=false`（离线模式）并只监听 `127.0.0.1`，不要把 25565 暴露到公网。

## 常见问题

**控制台显示「未连接」**
NapCat/SnowLuma 没启动、WebSocket 服务器没开、端口不对、或者 token 不一致。先确认 `ws://127.0.0.1:3001` 能连上（NapCat 的 WebUI 里能看到连接状态）。

**连上了但发消息没反应**
九成是白名单：把发消息的 QQ 填进「允许私聊的 QQ」，群聊要把群号填进「允许的群号」。群聊里还要 @ 它或说唤醒词。

**画图失败**
`pollinations` 免费额度是 1 张 / 45 秒，还会偶尔 503。想稳定就换 `siliconflow` 填个 key。失败时机器人会自己说“等会儿再画”，不会装死。

**回复太慢**
主模型 `deepseek-v4-pro` 本身偏慢；想快就把 `llm.model` 改成 `deepseek-flash`，或者在控制台把 `firstDelayMs` 调小。

**人格没变化**
人格文件在 `data/persona.md`；控制台保存会立即重新读，直接改文件也行（下次回复生效）。

**会不会封号**
用小号、别群发、别刷屏。第三方协议端（NapCat/SnowLuma）本身就违反 QQ 用户协议，风险自担；出图/聊天频率也别太夸张。这个项目是自用工具，不是给你拿去运营机器人号的。

## 合规提醒

NapCat、SnowLuma 都是第三方项目，与腾讯无关；使用前请阅读它们的许可和 QQ 用户协议。把个人 QQ 号交给协议端登录存在被风控/封号的现实风险，请只用小号，并自行评估。
