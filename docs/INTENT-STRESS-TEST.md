# 意图识别刁钻测试

题库 `scripts/architecture-adversarial-cases.mjs` 固定为40个场景、48轮对话，每个类别5个场景：否定范围、引用与附件指令、精确参数、缺失与歧义、数据真实性、查询与多任务、多轮状态、能力与交付边界。

这是一轮先固定答案再测模型的基线评测，不训练模型权重。本轮没有为新题修改生产识别器。题目与预期是测试数据，不是执行指令；只把当前题目、附件样例和当前会话状态送给实际识别器，不把评分标准送给模型。

## 运行

在包含本次改动的开发分支项目目录运行，不切换或更新 main：

```bash
node scripts/evaluate_architecture.mjs --suite=adversarial --live --model=deepseek-v4-pro --out=reports/adversarial-live.html
```

默认读取本机 `config.json` 的 `llm` 配置，也可用 `QQBOT_CONFIG` 指向现有本地配置。云环境可在环境设置中安全注入 `DEEPSEEK_API_KEY`；评测器直接在内存中使用它，不写入配置文件或报告。可用 `LLM_BASE_URL` 覆盖接口地址。此环境变量支持仅属于评测脚本，不改变机器人主入口的配置方式。

缺少密钥时仍运行本地自动检查、生成HTML和JSON，但将模型题目标为未运行并以非零状态退出。不要在命令行参数、聊天、报告或代码里填写密钥。切勿为了准备测试覆盖已有个人配置。

默认题库仍可使用 `--suite=standard`。筛选和稳定性复测示例：

```bash
node scripts/evaluate_architecture.mjs --suite=adversarial --live --model=deepseek-v4-pro --case=turn-retain-no-images --repeat=3 --out=reports/adversarial-repeat-live.html
```

云环境使用Node.js 24并通过HTTPS代理出网时，需要显式启用代理和系统证书（保持TLS验证）：

```bash
node --use-env-proxy --use-system-ca scripts/evaluate_architecture.mjs --suite=adversarial --live --model=deepseek-v4-pro --out=reports/adversarial-live.html
```

模型名称以实际账户返回为准。本次账户提供 `deepseek-v4-pro` 和 `deepseek-flash`，没有旧报告使用的 `deepseek-chat`；本次实测选择项目默认的 `deepseek-v4-pro`。不同模型的分数不能直接归因于代码优化。

真实调用会产生文本模型费用。40个场景不是40次API请求：识别、格式修复、规划、工具选择和总结分别调用模型。工具均为模拟实现，不发送QQ、不调用收费媒体服务、不写真实记忆。翻唱场景只验证识别字段和停止边界，没有接入真实曲库核验或交付。

只列题库并检验代码、不调用模型：

```bash
node scripts/evaluate_architecture.mjs --suite=adversarial
```

## 如何读分数

- 场景分：一个场景所有轮次都满足事先定义的操作、参数、禁止项、工具及状态约束，才算通过；按类别分别统计。
- 轮次分：单独列出每轮通过、失败、服务错误和未运行数。一个多轮场景失败不等于其中每轮都失败。
- 认证、额度、网络等模型服务错误单独记录，不算语义错题，也不算通过。服务错误后停止剩余测试，避免在无效状态上继续多轮对话。没有可评分样本时准确率为 `null`，不是0%或100%。
- 自动测试数量只证明程序断言通过，不是实际模型答对的题数。图像和语音使用预先解析的证据，不测OCR、ASR或真实产物质量。
- 展开结果可对比 `recognizedIntent`（模型最后一次结构输出）、`intentAttempts`（含格式重试）和 `intent`（合并状态、字段修正后的执行意图）。最终场景通过率不能直接叫作“原始意图识别准确率”。
- 报告保留题库哈希 `suiteHash`、模型、代码版本和工作区修改标记；比较不同轮次时应固定题库、模型及运行选项。

看完真实错题后再调整识别逻辑，并用新题做第二轮验证。不要用为题目编写的模拟答案冒充模型表现，也不要为了通过而放宽预先冻结的评分条件。
