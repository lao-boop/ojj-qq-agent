> 当前源码为v4候选。新增多人多轮测试请优先看 [BUSINESS-V4.md](BUSINESS-V4.md)。下文v3与更早实验已冻结；`upgraded` 指当前候选，`v3` 才是冻结v3。

# 小鲸鱼定时汇报实验

当前生成器是v3（`source-first-v3`）。本目录以原始/关键事实/无关细节三版合成输入，检查重要性、更正、未定状态和表达清晰度。模型不读取review评阅字段，不自动生成一个总分。

## 只测试当前v3

在仓库根目录执行，无密钥时先走替身链路：

```bash
npm run experiment:secretary -- --split dev
```

已有本机模型配置时，显式增加 `--live` 才会产生真实API调用：

```bash
npm run experiment:secretary -- --live --split dev --config /绝对路径/config.json
npm run experiment:secretary -- --live --split fresh --cases-file experiments/secretary/fresh-v3.json --config /绝对路径/config.json
```

密钥可以通过 `DEEPSEEK_API_KEY` 注入。读取其他目录的.env时，需由Node的 `--env-file` 或进程环境显式加载；`--config` 本身只读取JSON模型配置。不要将密钥写进命令或提交到Git。

默认写入唯一的 `tmp/` 目录，包含manifest、逐次调用、原话、实际转告和review.md。`--case-id staffing --variant key --split holdout` 可选择单例；不带 `--live` 的文字都是模型替身输出，不能作为理解能力证据。

## 扩展到50个输入（仅v3）

```bash
npm run experiment:secretary:50
bash experiments/secretary/run-mac-v3-50.sh
```

第一条只用替身；第二条在Mac调用真实模型。16组三版加2个正常原版，共50例；保留原10例、新增40例，不改v3算法。支持暂停和自动续跑，细节见 [50例说明](SUITE-V3-50.md)。

## 验证了哪条路径

使用实际 `runtime.handle → capture → tick → briefingMaterial → scheduledWriter → sender`；日常应答和收件人替换，不调用 `app.start()`，不会连接企业微信。模拟ACK丢失，检查确认前不推进游标、发送重试不再调用模型、无新增不重发，以及访问范围和历史原文进入当前输入。

当前v3入口统一60秒/请求、HTTP尝试1次；历史通过归档及定时路径准备，摘要由明确标记的替身产生，不进行历史模型预热。这是当前生成实验，不是历史摘要能力或生产投递验收。时间只推进秘书时钟，不代表多日边界测试。

## 可选的历史对照

历史writer仅用于可重复比较，不会同时安装为生产生成器：

| 参数 | 冻结代码 |
| --- | --- |
| `baseline` | cf06a72，旧单阶段 |
| `previous` | 4fc65d1，v1两阶段 |
| `v2` | 1df1a18，v2显式背景两阶段 |
| `upgraded` | 当前 `src/wecom-scheduled-briefing.js`，v3 |

```bash
npm run test:secretary
bash experiments/secretary/run-mac-v3.sh
```

第一条是完整42单元的替身回归。第二条是Mac上的真实v2/v3配对实验，读取既有运行目录的模型配置，独立使用官方Node24，不安装或启动机器人；默认先跑4个核心输入，v3全部生成后继续6个新场景。若只希望测试v3，使用上面的 `experiment:secretary`。

所有比较须保持输入、模型和预算一致；失败usage记未知，不以不同成功集合的均值宣称性能提升。需要续跑时使用 `--resume-from`，运行器检查代码哈希、场景、历史模式和预算，拒绝混入不兼容结果。

## 已有证据

- [v3真实模型记录](../../docs/reports/v3-2026-11-21.md)：正文、失败与性能；当前版本为主，旧版对照放附录。
- [v3设计与验证计划](ITERATION-V3.md)：改动、代价和实验边界。
- [v2设计记录](ITERATION-V2.md)、[更早实验记录](LEGACY-EXPERIMENT.md)、[论文方法取舍](RESEARCH.md)：历史背景，不代表当前结果。

这批新场景已经用于评阅，后续据此修改提示时要另留新场景复核。汽配问答成绩不代表员工向老板汇报的质量。
