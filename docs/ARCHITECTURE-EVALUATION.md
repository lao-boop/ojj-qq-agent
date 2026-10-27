# 架构评测与 HTML 报告

测试分为三层，结果不能混算：

1. 自动回归：运行 `tests/*.test.js`，验证意图结构、权限、否定、参数绑定、跨会话隔离、专业 Agent、超时和发送回执。模型及外部接口是模拟的。
2. 真实模型路由：使用本机 `config.json` 的 `llm` 配置，调用实际 IntentRecognizer 和 AgentManager；只使用生产工具的 schema，执行器完全替换为内存模拟。没有真实QQ发送、媒体生成、记忆写入或公开发布，只有文本模型调用计费。图片和附件使用预先解析样例，不能代表视觉或ASR准确率。
3. QQ人工验收：通过真实账号、真实文件核对生成内容及送达，人工在HTML中标记。浏览器中的记录可导出JSON，未标记项目不算通过。

## 命令

```bash
node scripts/evaluate_architecture.mjs
open reports/architecture-report.html
```

默认只运行本地测试，不调用你的模型API。报告包括实际测试结果、34个真实模型场景（未运行时为灰色）、8项人工验收。

先用一项检查本机API与评测流程：

```bash
node scripts/evaluate_architecture.mjs --live --case=ppt
open reports/architecture-live.html
```

全量运行、限定数量、重复测试：

```bash
node scripts/evaluate_architecture.mjs --live
node scripts/evaluate_architecture.mjs --live --limit=6
node scripts/evaluate_architecture.mjs --live --case=research-document --repeat=3 --out=reports/repeat-live.html
```

通过 `QQBOT_CONFIG` 可以指定另一个本地配置文件。无需启动NapCat。评测不修改机器人配置或真实数据；报告只写指定的HTML及同名JSON，**不要提交包含本机模型回复和人工备注的实测报告**。`architecture-live.*` 和 `*-live.*` 默认已在 gitignore 排除；自定义输出路径请自行检查。

预期答案定义在 `scripts/architecture-cases.mjs`，不会发送给模型。每项场景有独立内存任务状态，多轮测试只共享自己的场景状态。模型错误不会通过重放真实工具来修复。每完成一个场景保存一次，测试失败仍生成报告并以退出码1退出；“失败”是评测结果，不代表HTML生成失败。

## 评分

整项场景所有轮次满足预先定义的状态、动作、工具、约束和关键参数才算通过；多余或缺失的工具调用都失败。搜索后制作报告检查Agent依赖与调用顺序。生成任务只能记录为模拟排队，不声称已交付真实文件。多轮任务检查修改/取消/查询语义及实际任务状态。

自动回归与语义场景通过率分开统计；重复测试按运行次数统计。异常工具调用指标按实际多调工具的轮数统计，**不包含漏调、错误参数等其他失败**，需同时看整体失败列表。界面可按状态筛选、搜索，逐轮展开预期与实际数据。

目前通用传话与空间发布尚未接入Manager，对应场景预期明确停止/追问，不是成功执行。这两项“通过”仅表示没有越权执行。翻唱已有自动回归，但本次语义用例集中于其他能力。

这套固定用例是回归基准，不是任意自然语言的准确率保证。后续应加入真实失败表达和保留一批未参与提示词调试的测试语句；口语、错字、否定、缺附件、修改指令可分别建立分组，重要场景至少重复3次。
