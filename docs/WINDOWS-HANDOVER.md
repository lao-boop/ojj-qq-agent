# 把现有QQ机器人完整交给Windows用户

本交接沿用之前修复过的开发代码，不修改main，不新建机器人QQ号。此前终端确认的机器人是 **瘦鱼，QQ 3489314835**。原主程序在原主人的Mac上运行；OneBot v11是QQ接入协议，NapCat/SnowLuma等程序负责实际QQ登录。本项目是连接它的Node.js主程序。

## 交出去的是哪些东西

| 部分 | 在哪里 | 怎么交 |
| --- | --- | --- |
| 完整源代码、依赖锁、Windows脚本、原有测试和报告 | 本公开交接包 | 直接下载转发 |
| 当前API密钥、实际配置、人设、聊天记录、长期记忆、任务及交付状态、媒体文件 | 原Mac的config.json和data目录 | 原主人在Mac本地导出，私下发给接管人 |
| 曲库 | 配置中的library.dir | 找得到的本地目录会一起导出；找不到会提示 |
| QQ登录、密码、扫码、账号绑定及找回方式 | QQ账号及QQ接入程序 | 两人在QQ官方流程中完成登录/交接，不在公开包中 |
| 外部音色模型、云端资源 | 原服务商账号/配置中的URL | 配置保留；未存于data或曲库的本地资源需另行复制，云端资源不会自动下载 |

公开包没有原主人的真实配置、API密钥、QQ登录状态、聊天数据库，也没有node_modules、Mac虚拟环境或第三方安装器。它不是免安装的Windows EXE。Windows端安装Node依赖需要网络。

## 原主人：从Mac导出私人交接包

1. 在运行机器人那个终端按 **Control+C**，停止旧主程序。停止后再导出，避免复制到一半数据仍在变化。QQ接入程序的账号交接另行安排。
2. 在原来的 `ojj-qq-agent` 目录执行：

```bash
git fetch origin &&
git switch fix/windows-friend-test-bundle &&
git pull --ff-only origin fix/windows-friend-test-bundle &&
node scripts/friend-handover.mjs export
```

Git若报告本地修改冲突就停止，不要强制重置。脚本读取原有 `config.json` 和 `data`；如果启动时用了 `QQBOT_CONFIG` / `QQBOT_DATA`，导出时也应保留相同环境变量。

3. 正常情况下会在你的用户主目录生成 `ojj-private-transfer-日期-编号.zip`，终端显示完整路径。也保留同名文件夹。导出只复制，不删除原文件、不上传网络。
4. **把这个私人ZIP直接私下交给新主人**。里面有实际密钥和完整历史，不要放入公开GitHub，也不必发到本聊天。
5. 协助新主人在他的QQ接入程序中登录**同一个机器人QQ号**。账号绑定、找回信息等通过QQ本身交接；本工具不提取登录票据，也不能代替扫码。
6. 朋友上线后，旧Mac不再运行 `npm start`。避免同一账号由两套主程序同时回复。

## 新主人：Windows安装和接管

### 1. 解压公开代码包

把整个公开ZIP解压到例如 `C:\QQBot`。进入其中的 `ojj-qq-agent` 文件夹；这里应有 `setup-windows.cmd`、`start-windows.cmd` 和 `package.json`。不要直接在压缩包预览窗口里运行。

安装 **Node.js 24 LTS**（本项目最低20）：<https://nodejs.org/en/download>。安装后关闭旧终端再打开。文字聊天不需要Python、FFmpeg或GPU。

### 2. 放入私人交接资料

解压原主人私下发来的ZIP，把其中含 `TRANSFER.json`、`config.json`、`data` 的那层目录改名为 `private-transfer`，放在 `ojj-qq-agent` 里面：

```text
ojj-qq-agent/
  setup-windows.cmd
  start-windows.cmd
  package.json
  private-transfer/
    TRANSFER.json
    config.json
    data/
    external/music/    （如果原曲库存在）
```

不要手动用原Mac的config.json覆盖程序根目录。导入向导要先校验文件、转换本地路径并更换主人权限。如果没有私人包，也能创建新配置并登录同一QQ，但不会带上旧记忆或原密钥。

### 3. 在Windows启动QQ接入程序

使用支持 **OneBot v11 正向WebSocket服务端** 的QQ接入程序，登录现有机器人QQ。可以沿用原来的NapCat/SnowLuma方案，但要安装Windows版本，Mac上的Docker登录目录不能直接当Windows程序运行。

在其网络设置中开启：

- WebSocket **服务端 / 正向WebSocket**，不是反向WebSocket，也不是HTTP API。
- 同一台Windows电脑上，地址 `127.0.0.1`，端口 `3001`，启用消息事件推送。
- 如设置了access token，下一步向导填写同一个值。管理页面密码和OneBot token是两个不同的东西。
- 使用自己的个人QQ给机器人发消息；个人QQ与机器人QQ必须是两个账号。添加好友请求需要在QQ接入端/QQ里确认。

**外部安装包核对记录（2026-11-20）**：Node、Python、QQ和FFmpeg官网可访问；NapCat项目页可访问，但发布API未返回可下载版本，旧文档和SnowLuma旧latest入口未能取得可用安装包。因此本包没有附带或宣称验证过这些第三方Windows安装器。优先向原主人确认现用QQ接入程序的安装来源，再从对应项目的正式发布渠道获取；不要把代码包当成已含QQ接入端。参考入口见后面的下载清单。

### 4. 双击setup-windows.cmd

它会安装Node依赖，然后询问：

- **你的个人QQ号**：用来给机器人发消息的号码；不要填3489314835。它会成为新主人和管理员，旧主人的管理授权会被替换，群聊先不开放。
- 称呼、模型接口地址、模型名称：有私人包则默认沿用原设置。
- API密钥：输入不回显；有旧值时回车保留。若希望费用也由新主人承担，填写新主人自己的模型密钥；沿用旧Key仍计入旧服务账号。
- 本机OneBot地址和token：按上一步设置填写。token回车保留原值，输入单独的 `-` 表示清空。

本地导入保留历史会话的原用户归属，不会把旧主人的个人偏好伪装成新主人的。新主人是新的会话；旧文件及记忆仍在data内。全局主人称呼会更新，原配置和全局信息备份在 `data/handover-original-*.json`。自定义人格文字若硬编码了旧主人称呼，可自行修改 `data/persona.md`。

Mac文档/媒体索引中位于原data下的路径会改为Windows新data路径，原发送状态保留。未确认的上传不会因接管而自动重发；旧任务也不会自动开始。其他指向Mac外部目录的资料需要手动迁移，文件映射应按WindowsQQ接入端重新设置。

### 5. 双击start-windows.cmd

保持QQ接入程序在线，再运行主程序。看到 `OneBot 已连接`、正确的 `登录账号`、`机器人就绪` 后，用你的个人QQ私聊机器人发 `/status`，再按后面的测试表测试。保持启动窗口打开；按Ctrl+C停止。

### 6. 不回复时怎么检查

- `check-windows.cmd`：检查本地配置、依赖及模型目录接口，不发聊天、不修改配置。某些兼容服务不支持 `/models`，这项失败需结合服务商接口说明判断。
- `diagnose-onebot-windows.cmd`：30秒内用个人QQ给机器人发“测试”；只检查登录和事件，不调用模型、不替你发QQ消息。若主程序同时运行，它可能正常回复。
- `self-test-windows.cmd`：本地模拟测试，不是真实QQ上线证明，不需要模型Key。
- 窗口马上关闭/缺node：安装Node后重开终端。
- 401/403：核对对应服务的API Key或OneBot token，二者不要混用。
- 已连接但无消息事件：检查发给的QQ号、事件推送、正向WS设置。
- “忽略未授权私聊”：核对新主人的个人QQ是否填对；要开放其他好友，在config.json的access.privateAllow中增加其QQ号并重启。
- 文件导入校验失败或目录已有数据：保留现场，重新解压一个干净代码目录再导入，不要强制覆盖运行数据。

## 其他功能也已包含，但需补依赖

导入保留服务商设置和密钥，不过首次接管默认只开文字、记忆与受控任务流程。语音、出图、唱歌、翻唱、ASR、曲库、视觉、空间、传话先关闭，避免未装依赖就执行。控制台也默认关闭。原配置可在本机 `data/handover-original-config.json` 对照查看，不要公开它。

| 功能 | 要准备什么 | 如何启用/检查 |
| --- | --- | --- |
| Word/PPT/Excel、Office/PDF读取 | Python 3.12 + 文档依赖 | 安装Python后运行install-office-windows.cmd；已配置.venv/Scripts/python.exe |
| 语音、音频转码、视频抽帧 | FFmpeg；Python的edge-tts、pilk等 | 运行install-multimedia-windows.cmd；FFmpeg加到PATH；tts.enabled=true，按实际服务商配置provider |
| 本地语音识别 | faster-whisper、FFmpeg、Python；首次下载模型 | 上一项依赖后设置asr.local.enabled=true；模型下载和CPU运算需要时间 |
| 云端语音/识图 | 对应服务的接口、模型、Key/音色 | 按原配置核对tts.minimax或vision，验证后开启 |
| 画图、原创歌、RVC翻唱 | 对应API账号、模型/音色资源；翻唱另需可用曲库/音频 | 对照docs/COVER-SETUP.md和原配置，分别开启image/song/voice/library；不代表这些服务现在都有额度或资源可用 |
| 曲库 | 本地音乐文件 | 导入后若有external/music，路径为data/music；确认文件后启用library |
| 浏览器控制台 | 仅本机访问的控制台密码 | config.json设console.enabled=true、host=127.0.0.1、非空token；浏览器打开http://127.0.0.1:3010 |
| QQ空间/传话 | QQ接入端对应能力和明确授权范围 | 程序有适配代码；当前受控任务架构仍有支持范围限制，不能视为已完整上线功能 |

Python安装选择3.12并安装Python Launcher，文档安装脚本用 `py -3.12`。不要把原Mac的.venv复制到Windows。多媒体依赖中的某个包若没有适配本机的wheel，可能需要额外编译工具；本包不承诺所有Windows机器一次装齐所有声音功能。

## 软件下载入口

- Node.js：<https://nodejs.org/en/download>
- Python Windows：<https://www.python.org/downloads/windows/>
- QQ Windows：<https://im.qq.com/pcqq/index.shtml>
- NapCat项目：<https://github.com/NapNeko/NapCatQQ>（当前发布入口可用性见前述核对记录）
- SnowLuma原项目入口：<https://github.com/SnowLuma/SnowLuma>（旧latest链接本次返回404，需确认现用来源）
- FFmpeg：<https://ffmpeg.org/download.html>（按官网指向的Windows构建安装）
- 模型服务账号：<https://platform.deepseek.com/>，或原配置实际使用的兼容服务。

本开发线运行配置读取config.json；不要照另一条main分支的教程只填写.env，就以为已配置成功。

## 接管验收

1. QQ接入端登录的确是原机器人QQ；旧Mac主程序已停止。
2. 新主人的QQ可收到 `/status`，旧主人不再自动拥有管理员权限。
3. 分别发送“。”“，，，”“今天吧，就，啥也没干但好累”，正常接话，不要求填写任务结构。
4. “记住我的饮料偏好是乌龙茶”，再问保存了什么；“删除这条饮料偏好”，确认实际删除。
5. “先建Word活动介绍草稿，3节，暂时不要生成”，再发👍，不应开始制作；最后明确取消。
6. 装完文档依赖后请求3节Word，确认QQ收到且能打开。排队提示不能代替文件送达。
7. 有失败时记录输入、回复、发生时间、期望结果。分享日志前去掉密钥和无关私人聊天。

本次交接工具在Linux云环境验证导出/校验/导入、主人权限变更、路径转换，以及真实机器人子进程+模拟OneBot收发；不是Windows实机QQ登录验收。Windows接入端登录、真实API额度、文件和语音送达由接管人按本表确认。
