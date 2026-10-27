# 分支与本机切换

- `main`：已恢复到原始开源版本 `1f2e919` 的文件内容。通过还原提交保留完整历史，没有强制改写提交记录。
- `dev/agent-architecture`：保留此前全部已提交的意图理解、Agent Manager、多模态、翻唱、诊断和评测改动；后续开发、修复和测试都在这里进行。
- `archive/secretary-wip`：早期尚未完成、未经过完整验收的秘书项目模块草稿，基于 `ae505c1` 单独归档。供后续整合参考，不视为当前开发分支的已验证功能。

停止本机机器人后，在现有项目目录切换：

```bash
cd ~/qq-agent-dev/ojj-qq-agent
git fetch origin
git switch dev/agent-architecture
git pull --ff-only origin dev/agent-architecture
npm start
```

第一次 `git switch` 会根据同名远端分支建立本地跟踪分支。个人 `config.json` 和运行数据未纳入 Git，不会被这些命令重写；如果 Git 提示有已跟踪文件的本地修改会被覆盖，先保存这些修改，不要使用强制切换或清理命令。

后续只更新 `dev/agent-architecture`。不要将 main 的还原提交合入开发分支，否则会再次撤掉功能。两个分支如需未来重新整合，应先明确是否恢复 main 上的功能，而不是直接自动合并。

本机真实模型复测：

```bash
node scripts/evaluate_architecture.mjs --live --out=reports/routing-v2-live.html
open reports/routing-v2-live.html
```
