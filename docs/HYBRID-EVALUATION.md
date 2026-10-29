# 架构改造实测结果

工作分支：`fix/architecture-routing-report`。main 未修改。

模型为 `deepseek-v4-pro`，题库 `adversarial-v1`，共40个场景、48轮对话。三轮题库和评分函数相同，最终结果来自一次完整复测，没有拼接各轮最佳成绩。

| 版本 | 通过 | 未通过 | 服务异常 | 全部40题通过比例 | 可评分通过率 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 改造前 | 28 | 11 | 1 | 70.0% | 28/39 = 71.8% |
| 改造第一轮 | 34 | 5 | 1 | 85.0% | 34/39 = 87.2% |
| 修正后完整复测 | 39 | 1 | 0 | 97.5% | 39/40 = 97.5% |

最终相对基线12项改善、1项退步、27项状态未变，全部场景通过比例增加27.5个百分点。最终48轮对话中47轮通过；173项本地回归测试全部通过。

## 剩余问题

`missing-old-file`：用户要求根据上个月发送的合同生成摘要，无法定位则先询问。最终系统正确保留草稿、要求文件名或重新发送合同，未调用工具、未生成模板。但意图契约比预期多出 `memory.read`，按冻结评分规则仍判未通过；基线此题通过，因此列为退步。没有为了消除这项失败而放宽评分。

## 改造内容与比较边界

模型生成跨角色计划、逐个调用专业Agent和另行汇总，改为单个执行Agent共享工具历史。结构化任务契约、会话状态、权限校验和受控翻唱仍保留，程序工作流检查依赖和工具回执。另修正了否定范围、暂缓草稿、字段抽取、超限参数处理，以及输出截断后的有界修复。详见[架构说明](SINGLE-AGENT-WORKFLOWS.md)。

这是完整场景通过率，包含理解、程序校验和模拟执行，不是单独的意图分类准确率。真实调用文本模型，但业务工具模拟，图片/语音使用预解析样例，不涵盖真实媒体生成、OCR/ASR、QQ交付或企业群聊检索。

这些测试已用于指导修改，尚无独立盲测数据；每版只有一轮完整采样，模型存在波动。改造包含架构、契约、提示词和输出预算，不能单独归因于Agent数量，也不是模型权重训练。不能用40题推导生产环境97.5%准确率。

模型调用数：118 → 89 → 93；输出token：87393 → 53557 → 57720。基线包含超时补跑，并发设置也有变化，因此这些数字仅用于审计，不作为独立性能结论。

## 原始记录与复现

本次云工作区的报告保存在 `tmp/`，不提交原始模型回复：

- `tmp/hybrid-comparison.html` / `.md` / `.json`：三轮对比与逐题详情。
- `tmp/intent-stress-results.html` / `.json`：改造前完整记录。
- `tmp/hybrid-after-live.html` / `.json`：改造第一轮完整记录。
- `tmp/hybrid-final-live.html` / `.json`：修正后完整复测。

题库哈希（SHA-256）：`43b52fec96c3b75d83b2a617a975c892cb754a4eec1b4bbf7380c7b5491db9b6`。

使用安全配置的 `DEEPSEEK_API_KEY` 运行：

```bash
node --use-env-proxy --use-system-ca scripts/evaluate_architecture.mjs --suite=adversarial --live --model=deepseek-v4-pro --concurrency=2 --out=tmp/hybrid-new-live.html
node scripts/compare_architecture.mjs --after=tmp/hybrid-new-live.json --out=tmp/hybrid-new-comparison.html
```

代理参数适用于当前 Node.js 24 云环境。对比脚本需要工作区中的基线及第一轮记录；不能将别的模型或题库报告直接混入。
