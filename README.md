# 小鲸鱼 · 企业微信 AI 秘书 / QQ 聊天机器人

[![CI](https://github.com/lao-boop/ojj-qq-agent/actions/workflows/ci.yml/badge.svg?branch=codex%2Fwecom-integration)](https://github.com/lao-boop/ojj-qq-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

员工把事情告诉小鲸鱼，小鲸鱼保留原话、补足上下文，再把重要变化和还没确定的事情转告负责人。判断与决策留给负责人。

企业微信使用官方长连接 SDK，不需要公网回调域名。QQ 使用 OneBot v11，保留独立的人格、会话与聊天入口。

## 当前能力与边界

- **定时汇报**：启用后默认每60分钟检查，只在其他成员有新增消息时私聊配置的负责人。
- **原文追溯**：独立归档；通过 `/来源`、`/原文` 查看依据，权限由程序按 UserID 判断。
- **发送确认**：生成后保存待发内容，确认后推进进度；失败重用已生成正文。ACK丢失仍可能导致重复投递，不保证严格一次送达。
- **日常对话与文档**：支持企微聊天、文件阅读、Office生成和文档收件箱；文档等扩展能力有额外依赖。
- **QQ聊天**：保持原有 OneBot 入口，详细设置见 [QQ使用指南](docs/QQ.md)。

当前定时生成器为 **v3（source-first-v3）**：一次模型请求生成短汇报及逐字原文依据。引用校验不等于事实核验，重要事项排序和简洁性仍在改进。

[2026-11-21真实模型记录](docs/reports/v3-2026-11-21.md)：10个合成输入全部生成，三组更正与未定状态表达较好，但部分正文仍先讲旧背景或无关细节。这不是生产可用率或质量满分，测试收件人为替身。版本历史见 [CHANGELOG](CHANGELOG.md)。

## 从源码启动企业微信

推荐 **Node.js 24 LTS**（`.nvmrc`），Git，以及可访问企业微信和模型接口的网络。Python只在启用文件/Office等能力时需要。以下用于新的克隆目录；已有安装请先阅读[运行与更新](docs/OPERATIONS.md)。

```bash
git clone --branch codex/wecom-integration https://github.com/lao-boop/ojj-qq-agent.git
cd ojj-qq-agent
npm ci
cp .env.example .env
```

编辑本地 `.env`：

```dotenv
CHAT_PLATFORM=wecom
WECOM_BOT_ID=你的智能机器人BotID
WECOM_BOT_SECRET=你的智能机器人Secret
DEEPSEEK_API_KEY=你的模型密钥
```

```bash
npm run start:wecom
```

打开本地控制台 <http://127.0.0.1:3010>：配置访问范围、成员身份以及“秘书汇报与消息溯源”的负责人 UserID，并启用汇报。默认不启用秘书功能，启用前的聊天不会自动补录。**同一个 Bot ID 只运行一个实例。**

完整的凭据来源、配置、代理、文档依赖和权限说明见 [企业微信指南](docs/WECOM.md)。未指定平台时 `npm start` 默认使用QQ；可用 `npm run start:qq` 明确选择QQ。

## 本地验证

```bash
npm ci
npm test
npm run check:release
npm run test:secretary
```

- `npm test`：本地模型/传输替身回归，不需要密钥；已有 `npm run test:wecom` 入口保留。
- `npm run check:release`：检查安装更新清单是否与源码哈希一致，不联网、不安装。
- `npm run test:secretary`：实际定时链路的42个运行单元，模型和收件人为替身，不是语言质量成绩。输出在新的 `tmp/` 目录。
- Office二进制渲染测试需要Python库；本地缺少时会明确跳过。CI安装这些库并要求该项执行，配置见 [贡献指南](CONTRIBUTING.md)。

真实模型测试会产生API调用。仅测试当前v3的开发场景：

```bash
npm run experiment:secretary -- --live --split dev --config /绝对路径/config.json
```

可通过环境变量 `DEEPSEEK_API_KEY` 提供密钥。实验采用60秒单请求预算、测试收件人和替身历史准备，不启动企业微信；结果含原话、实际正文、错误、耗时及usage。更完整的分组方法、Mac入口和可选历史对照见 [实验指南](experiments/secretary/README.md)。`npm run test:e2e` 是旧QQ真实模型烟测，会调用模型，不放进CI。

## 项目结构

| 目录 / 文件 | 用途 |
| --- | --- |
| `src/wecom-main.js` / `src/wecom-runtime.js` | 企业微信组装、访问控制与消息处理 |
| `src/wecom-secretary.js` | 原文归档、上下文选取、定时汇报和发送确认 |
| `src/wecom-scheduled-briefing.js` | 当前v3定时摘要生成器 |
| `src/wecom-briefing.js` | 主动查询汇报生成器 |
| `src/index.js` / `src/llm.js` | QQ入口 / 共享模型客户端 |
| `test/` | 自动化回归与明确标注的测试数据 |
| `experiments/secretary/` | 场景、运行入口及冻结的历史对照 |
| `docs/` | 使用、架构、运维与实测记录 |
| `data/` / `config.json` / `.env` | 本机运行数据与配置，不提交Git |

详见[汇报架构](docs/ARCHITECTURE.md)、[运行与更新](docs/OPERATIONS.md)、[参与开发](CONTRIBUTING.md)。代码采用 [MIT许可](LICENSE)，外部平台、模型及素材适用各自条款。
