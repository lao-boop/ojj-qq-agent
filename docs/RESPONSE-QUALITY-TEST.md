# 回答与交付质量测试

上一轮40题衡量“理解 → 校验 → 工具”的执行契约：操作、参数、禁止项、依赖、多轮状态和队列回执。39/40通过不表示39份回答或文件都令人满意。它没有逐条检查回复是否完整、有用，也没有生成真实办公文件。

本轮新增21题：18个文字/多轮场景、3个文件场景。题目和验收条件在模型调用前固定于 `scripts/response-quality-cases.mjs`，哈希为 `e773df9498d69ed8aff706492eeb80f96522c301fb7654c36ab2ec1e207dfdff`。新测试期间不修改生产代码。

## 测什么

- 从真实 `Brain.respond` 入口取最终聊天气泡，包含项目默认角色设定和回复整理逻辑。
- 检查摘要、算术、冲突材料、未知信息、改写、决策、情绪支持、多轮记忆、来源引用和异常反馈。
- 检索返回固定样例以便核验，记忆仅在隔离会话内保存；不声称测了真实网络搜索或数据库可靠性。
- 文档队列使用现有生产工具适配器，按 `index.js` 的参数映射调用真实 Office 生成器，读取实际Word段落、Excel单元格、PPT页数和文字。没有QQ发送、图片生成或真实用户数据。
- 内容检查不等于视觉排版验收：当前没有Office渲染预览，不能据此声称页面美观、无溢出。

## 评分

准确、完整、切题、清楚、语气合适、如实说明状态，各0～2分。至少10/12分、没有0分且无关键错误，才算达到本轮标准。每题必须附输出证据及理由。

评审为Codex按明确条件逐题复核，不是独立人工用户满意度调查。报告展示输入、实际输出、评分理由、文件结构，支持用户自行评价并导出。字面匹配与长度检查只提示待核对项，不把合理同义表达直接判错。

服务异常、未运行、待复核独立统计，不能当作回答不合格或通过；没有可评分结果时满意度为 `null`，不是0%。不能直接将本轮内容分与旧的97.5%操作契约分比较。

## 当前状态与发现

新21题首次运行在代理连接阶段全部遇到异常，记录保留在 `tmp/response-quality-run/`。随后用户补充配置，当前实例网络与安全密钥绑定恢复，认证检查返回200；整套21题已在 `tmp/response-quality-live/` 完整运行，0次服务异常，没有覆盖原异常记录。

修复前按固定六维标准为16/21达标（76.2%）：文字/多轮15/18、真实文件1/3。随后修复反馈与生成逻辑，保持题库、运行入口和评分标准不变，完整复测为20/21（95.2%）：文字/多轮17/18、真实文件3/3。原五项未达标均改善，但预算题出现49元误说成50元且推荐摇摆，列为一项退步。完整结果见[评测与修复记录](RESPONSE-QUALITY-RESULTS.md)。这是Codex内容复核，不是独立人工用户满意率，也不能与旧的97.5%操作契约通过率直接比较。

改前固定大纲检查曾发现PPT传入 `pages=5` 得到7页，Excel内部路径后缀错误。修复后复查保存在 `tmp/office-quality-contract-after/`：5页PPT、3节Word、Excel的零值/负数/空白与xlsx后缀均符合要求。这些是生成器检查，与真实模型内容分分别记录。

## 运行

安全配置 `DEEPSEEK_API_KEY`，使用当前Node.js 24环境：

```bash
node scripts/evaluate_response_quality.mjs
node --use-env-proxy --use-system-ca scripts/evaluate_response_quality.mjs --live --out=tmp/response-quality-retry
node scripts/response-quality-report.mjs tmp/response-quality-retry
node scripts/check_office_quality_contract.mjs
node --test tests/response-quality-eval.test.js
node scripts/compare_response_quality.mjs
```

第一条只查看计划。真实测试会先检查模型连接；不覆盖已有输出目录。内容复核写入该目录的 `reviews.json` 后重新生成报告，每条形如：

```json
{"case-id":{"scores":{"accuracy":2,"completeness":2,"relevance":2,"clarity":2,"tone":2,"honesty":2},"critical":false,"rationale":"引用实际输出或文件检查证据"}}
```

固定大纲检查改前因PPT页数不符返回退出码1，修复后返回0。本地完整回归186项通过，随后页数语义提示的相关24项测试另外通过。测试脚本、报告和文档位于 `fix/architecture-routing-report`，main未修改。实际复测记录位于 `tmp/response-quality-after/`，对比报告为 `tmp/response-quality-comparison.html` / `.md` / `.json`；修改前记录完整保留。
