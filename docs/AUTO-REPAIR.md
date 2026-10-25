# 汽修多模态 Agent 评测

这个模块解决的是一个具体问题：**汽修群里的消息是多模态、碎片化、带业务边界的**——配件照片、车辆照片、VIN 采集卡、维修单、聊天截图、语音混在一起，而模型很容易“看着像就确认适配”。

评测脚本 `scripts/auto_repair_eval.mjs` 把这件事拆成可量化的流程。

---

## 一、数据集

使用 `auto_repair_multimodal_v1`（不随仓库分发）：

```
agent/inputs/{dev,test}_inputs.jsonl     # 输入
agent/knowledge/parts_catalog.jsonl      # 24 类配件库
agent/agent_prompt.txt                   # 官方系统提示
evaluator/{dev,test}_gold.jsonl          # 金标
tools/evaluate.py                        # 官方打分脚本
```

任务类型：

| 任务 | 说明 |
| --- | --- |
| part_identification | 配件类别识别 |
| fitment_boundary | 适配边界（能不能直接确认） |
| vehicle_observation | 车辆外观观察 |
| repair_order_extraction | 维修单字段提取 |
| vin_ocr | VIN 逐位抄录与冲突 |
| chat_context | 聊天上下文里的更正/取消 |
| speech_understanding | 语音里的否定项与单位 |
| cross_modal_consistency | 多附件是否同一车/同一单 |

---

## 二、评测流程

```
输入 JSONL
  │
  ├─ 图片 → 视觉模型转结构化文字（带缓存）
  │     · 配件：外观、形状、颜色、安装位置线索
  │     · 车辆：车身形式、颜色、明确回答有没有划痕
  │     · VIN：17 位逐位读，遮挡位用 ?
  │     · 单据：逐字转写、保留字段名
  │
  ├─ 语音 → WhisperX 转写（带缓存）
  │
  ├─ 拼 prompt：agent_prompt + 配件库 + 规则
  │
  ├─ 模型输出 JSON（三次尝试：主模型 → flash → 主模型更大额度）
  │
  └─ 调用官方 evaluate.py 打分
```

产物：

```
data/auto_repair/{split}-predictions.jsonl
data/auto_repair/{split}-report.json
```

---

## 三、运行

```bash
export AUTOREPAIR_DIR=/path/to/auto_repair_multimodal_v1

# dev 集（18 例）
node scripts/auto_repair_eval.mjs --split=dev

# test 集（26 例）
node scripts/auto_repair_eval.mjs --split=test

# 只重跑某几个案例（会与已有预测合并）
node scripts/auto_repair_eval.mjs --split=dev --only=C046
```

需要的依赖：

```bash
pip install faster-whisper pillow
npm install
```

Replicate token 用于云端 ASR；如果只跑纯文本/图片案例，可以只用本地视觉模型。

---

## 四、关键规则（踩过的坑）

这些都是实测有效的约束，写在 `scripts/auto_repair_eval.mjs` 的 `buildSystem()` 里：

1. **必填字段**：`part_ids / needs_clarification / fitment_confirmed / oe_number / action / reply / evidence / order_authorized / excluded_part_ids / cancelled_part_ids`
2. **VIN**：字母 O 与数字 0 严格区分；遮挡位用 `?`；部分可见时 `format_valid=null`；两个完整 VIN 冲突时 `visible_text=null`、`candidates=[...]`、`complete=true`
3. **单据**：`computed_total` 含工时重算；任一合计为 null 时 `amount_mismatch=false`；单据任务不要输出 vin
4. **车辆**：不猜品牌/年款；描述里出现划痕/擦伤 → `visible_scuff=true`
5. **聊天**：`customer` 是字符串；更正覆盖旧需求；取消写 `cancelled_part_ids`，明确不要写 `excluded_part_ids`
6. **语音**：`transcript` 只放转写；否定项写 `excluded_part_ids`
7. **追问**：遮挡无法识别 → `needs_clarification=true`；只是问“这是什么” → false

---

## 五、结果

| 轮次 | 案例通过率 | 字段通过率 |
| --- | --- | --- |
| 基线 | 46.2% | 85.4% |
| 第二轮 | 65.4% | 92.1% |
| 第三轮 | 80.8% | 92.7% |

最终分任务（test，26 例）：

| 任务 | 通过 |
| --- | --- |
| 配件分类 | 6/6 |
| 适配边界 | 3/3 |
| 语音理解 | 4/4 |
| 聊天上下文 | 2/2 |
| 车辆观察 | 2/2 |
| 跨附件一致性 | 2/3 |
| VIN 识别 | 2/4 |
| 维修单提取 | 0/2 |

语音 CER：7.5%（134 字错 10 字）。

---

## 六、注意事项

- **这不是微调**：数据集 README 明确说明它用于提示词调试/评测，不是微调格式
- **test 集被反复使用会失真**：上面的 80.8% 是第三轮结果，偏乐观
- **VIN OCR 是天花板**：合成图是采集卡小字，视觉模型逐位读只有 57%，靠提示词很难根治
- **真实数据才行**：合成图与真实车间照片差距大，长期要用脱敏真实数据

---

## 七、下一步

1. 修三条规则（单据 `part_ids`、双 VIN 冲突字段、`candidates`），预计 test 到 90% 左右
2. 修完只在 dev 上验证，不再动 test
3. VIN 单独裁剪放大做 OCR
4. 把结构化能力接进 QQ 聊天（“汽修模式”）
