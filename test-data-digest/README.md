# Agent 测试数据精简包

完整测试数据目录共 **47,712 个文件 / 15.9 GB**，不适合直接放入 GitHub。

这里采用“**指针 + 清单 + 脚本**”的结构：

```text
GitHub                → manifest.json / 脚本 / 摘要
Hugging Face Dataset  → 原始字节（建议 private）
ModelScope（可选）     → 同一份数据的镜像
```

GitHub 不存原始字节，只存可审计的指针和校验信息。

## 目录

```text
test-data-digest/
├── manifest.json            # 指针 + 每个文件的路径/大小/sha256
├── MANIFEST.csv             # 所有人可读的 CSV 索引
├── manifest-summary.json    # 文件数/大小/分类统计
├── scripts/
│   ├── fetch_data.py        # 按 revision 下载并校验
│   ├── verify_data.py       # 校验本地数据
│   └── build_manifest.py    # 从本地目录重建 manifest
└── summaries/               # 各测试方向的聚合结果
```

## 快速开始

### 1. 设置 HF 仓库和 revision

先创建 HF dataset（建议 private）：

```bash
hf auth login
hf repos create Lao0118/agent-test-data --type dataset --private
```

上传完整目录：

```bash
hf upload Lao0118/agent-test-data "C:\Users\潘旭忠\Desktop\Agent测试总库" . --type dataset --private
```

拿到该次上传的 **commit sha**，写进 `manifest.json`：

```json
{
  "sources": {
    "huggingface": {
      "repo": "<your-name>/agent-test-data",
      "repo_type": "dataset",
      "revision": "<commit-sha>"
    }
  }
}
```

不要只写 `main`。tag 可能移动，commit sha 不会。

### 2. 下载并校验

```bash
export HF_TOKEN=...          # Windows: $env:HF_TOKEN="..."
python scripts/fetch_data.py --manifest manifest.json --dest data/raw
python scripts/verify_data.py --manifest manifest.json --data data/raw
```

脚本会：

```text
已存在且 sha256 正确 → 跳过
sha256 不对 → 重下
下载中断 → .part 续传
每个文件下完 → 校验大小和 sha256
```

### 3. 只校验，不下载

```bash
python scripts/verify_data.py --manifest manifest.json --data data/raw
```

## manifest 结构

```json
{
  "schema_version": 1,
  "dataset": "agent-test-data",
  "version": "2026.11.26",
  "sources": {
    "huggingface": {
      "repo": "Lao0118/agent-test-data",
      "repo_type": "dataset",
      "revision": "<commit-sha>"
    }
  },
  "stats": { "files": 47712, "bytes": 17072523590 },
  "files": [
    {
      "path": "Agent拟人化功能测试数据与说明/...",
      "bytes": 12345,
      "sha256": "...",
      "category": "拟人化"
    }
  ]
}
```

## 摘要

| 方向 | 关键结果 |
| --- | --- |
| 拟人化 | 15 人五维评分，均分 8.80/10（见 human_likeness_15.csv） |
| 传话 | 老板→员工 156/160，老板→群聊 156/160；定时 50/50；附件基础 100/100 |
| 上下文容量 | 5k/10k/20k 各 1,000 题；reviewed 2,889/3,000 = 96.3% |
| 语音识别 | 500 条综合：句 83.2% / 字 97.5%；业务 200 条：句 91.5% / 字 99.45% |
| 文档识别 | PPT 2,000 页 1,950/2,000 = 97.5%；Word/Excel 达到 95% 目标 |
| 汽修识图 | 带知识库 989/1,000 = 98.9%；不带 963/1,000 = 96.3% |
| 四项生成 | 400/400 输出通过；模型调用 500/501；平均 9.6s |

## 注意

- 这是**测试归档摘要**，不是线上 SLA，也不代表真实业务场景的稳定准确率。
- 完整原始数据包含录音、图片、聊天记录和业务单据，默认不公开上传。
- 如果 HF 仓库是 private，下载必须提供 `HF_TOKEN`；不要把 token 写进仓库。
- 公开前必须脱敏：客户姓名、手机号、车牌、VIN、聊天记录。
