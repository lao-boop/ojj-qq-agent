# Mac 多模态部署

适用于 Apple Silicon Mac 主程序 + NapCat Docker，继续使用独立 QQ、config.json、data。代码更新不改本地配置。先保留现有文字对话已验证的 DeepSeek 模型；视觉服务可独立使用另一家 OpenAI 兼容接口。

## 更新和安装

在运行机器人终端按 Control+C；保持 Docker Desktop 和 NapCat 运行。在仓库目录执行：

```bash
git pull --ff-only origin main
npm install
brew install python@3.11 ffmpeg
python3.11 -m venv ~/qq-agent-dev/python-env
~/qq-agent-dev/python-env/bin/python -m pip install -r requirements-multimodal.txt
~/qq-agent-dev/python-env/bin/python scripts/configure_multimodal.py
npm start
```

已有虚拟环境可跳过创建命令。向导保留 QQ、DeepSeek、账号权限及人设配置，用当前 Python 解释器配置文档解析和本地 ASR；在本地隐藏输入密钥，原配置以 0600 权限备份至 `~/.qq-agent-backups/`。不要将运行配置提交到 GitHub。

## 服务设置

- MiniMax 国内站根地址 `https://api.minimaxi.com`，国际站 `https://api.minimax.io`。使用同步 `/v1/t2a_v2`，输出 MP3。配置 `tts.provider=minimax` 以及 `tts.minimax.apiKey/model/voiceId`；模型和音色须为账号可用项。默认示例 `speech-02-hd` / `male-qn-qingse`，可在向导更换。没有 MiniMax 密钥时保留原语音设置。语音 API 失败不自动重试扣费，也不自动换音色。
- 独立视觉配置 `vision.enabled/baseUrl/apiKey/model`。接口须接受 `/chat/completions` 中的 `image_url` 和 base64 图片。比如选择阿里云百炼时按其地域文档填写兼容接口地址与视觉模型名；不要把文字模型名当成视觉模型。向导留空则明确关闭视觉，不宣称能看图。
- 老配置未写 `vision.enabled` 时继续使用 `llm.visionModel` 和原文字服务；显式设 `false` 则停止视觉请求；`true` 时只使用独立视觉服务，失败不将图片或密钥发送给另一个服务商。
- 不确定 DeepSeek API 是否支持图片时，可以运行 `node scripts/check-vision.mjs /你的图片绝对路径.png`。未配置独立视觉时使用本地现有文字模型和密钥进行一次图片请求，不修改配置；核对返回描述是否与原图一致。检测失败不会自动购买或切换服务。如果省略图片路径，使用仓库示例图。此命令调用真实 API，按服务商计费。
- 本地语音识别使用 CPU faster-whisper small，需要 ffmpeg 和 pilk。默认最多 300 秒；首次下载模型较慢。模型从 Hugging Face 下载；若网络不通，可在启动前设置你能访问的 `HF_ENDPOINT`。`asr.enabled=false` 会停止转写请求；更改模型后重启旧 ASR 服务。
- 本地 ASR 可单独运行并查看加载错误：`~/qq-agent-dev/python-env/bin/python scripts/asr_server.py 8090`。不要在 8090 已被 ASR 占用时重复启动。健康检查：`curl http://127.0.0.1:8090/health`。首次加载超过机器人等待时间时，等待模型完成后再发语音。

## Docker 附件

NapCat 有时返回容器文件路径而不是可下载 URL。使用之前的 `./data/qq:/app/.config/QQ` 挂载时，向导添加：

```json
{
  "files": {
    "pathMappings": [
      {"remote": "/app/.config/QQ", "local": "/Users/你的用户名/qq-agent-dev/napcat/data/qq"}
    ]
  }
}
```

只映射实际共享目录。路径映射拒绝 `..` 和软链接逃逸。如果 NapCat 下载到另一目录，需要将该目录显式挂载到宿主机并添加相应映射。支持标准文件 URL / `get_file`；具体 NapCat 版本的私聊和群聊附件仍须分别实测。

## 验证顺序与边界

1. 文字：保持原 DeepSeek 对话正常。
2. 语音输出：发送“用语音说：今天下午三点开会”，确认收到可播放语音。
3. 语音输入：录一段包含人名、项目、时间的短语音，让它复述确认；再测试 30 秒以上音频。
4. 文件：发送 docx/xlsx/pptx/文字 PDF，让它总结。扫描 PDF 在未提取到任何文字时只渲染前 3 页交给视觉模型；混合扫描/文字 PDF 暂只提取文字层，不承诺全文 OCR。单文件下载上限 20MB。
5. 图片：发一张含数字的截图，检查数字是否正确。每轮最多识别 3 张，单图 8MB；失败或超出数量会明确告知，图片里的指令不作为用户授权。
6. 视频：最多抽取前 30 秒的一张代表画面，不能当作完整视频理解，也未转写视频音轨。
7. 文档输出：请求生成 Word/Excel/PPT，确认 QQ 收到并能打开；失败时核对 Python 依赖及 NapCat 文件上传接口。

MiniMax TTS 不等于翻唱。画图、原创歌曲、RVC 翻唱需要现有 image/song/voice 配置中的独立服务、音色模型或曲库；向导不把空密钥的开关全部打开。QQ 空间仍依赖扩展接口，NapCat 基础消息测试不证明空间可用。

代码测试使用本地模型和 OneBot 模拟服务，验证独立视觉路由、MiniMax 请求和失败处理、附件映射、文件读取以及回执。真实 API 额度、音色、Mac 依赖和 QQ 语音可播放性需在本机联调。
