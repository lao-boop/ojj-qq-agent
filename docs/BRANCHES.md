# 分支与本机切换

- `fix/architecture-routing-report`：本轮完整开发与修复代码，包含单主Agent工作流、文件交付、任务状态、记忆生命周期及标点闲聊修复。使用本轮结果应更新此分支。
- `main`：独立维护。2026-10-29只读检查时已包含Minecraft等另一套改动，且不包含本开发线的意图模块；本轮没有修改它，也没有自动把两条开发线合并。
- `dev/agent-architecture`：此前已提交的开发基线，停留在 `6bf9819`；不包含之后本轮的完整修复。旧安装文档里提及该分支的命令适用于旧版。
- `archive/secretary-wip`：早期尚未完成、未经过完整验收的秘书项目模块草稿，基于 `ae505c1` 单独归档。供后续整合参考，不视为当前开发分支的已验证功能。

停止本机机器人后，在现有项目目录切换：

```bash
cd ~/qq-agent-dev/ojj-qq-agent
git fetch origin
git switch fix/architecture-routing-report
git pull --ff-only origin fix/architecture-routing-report
npm ci
node scripts/check_runtime_profile.mjs
npm start
```

第一次 `git switch` 会根据同名远端分支建立本地跟踪分支。个人 `config.json` 和运行数据未纳入 Git，不会被这些命令重写；如果 Git 提示有已跟踪文件的本地修改会被覆盖，先保存这些修改，不要使用强制切换或清理命令。

以上命令针对正在使用本项目开发线的安装。先确认机器人进程所在目录及当前分支；如果实际运行的是含Minecraft功能的main版本，应先核对该部署的代码，不能把整条分支替换当作一个单文件修复。不要强制重置或覆盖本地变更。

闲聊修复使用 `chat.agents.enabled=true` 和 `architecture=single`。只读检查会显示当前配置，已有明确关闭或选择旧架构的配置不会自动更改。保留 `config.json`、`data/`、曲库和个人环境；不要用示例配置覆盖现有密钥或账号设置。

如果当前是PM2、systemd或其他方式托管的进程，应更新后重启原服务，不要再运行一份 `npm start`。服务名称和机器位置取决于实际部署，GitHub推送本身不会重启QQ机器人。

本机真实模型复测：

```bash
node scripts/evaluate_architecture.mjs --live --out=reports/routing-v2-live.html
open reports/routing-v2-live.html
```
