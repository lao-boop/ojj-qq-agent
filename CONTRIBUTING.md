# 开发与贡献

当前企业微信工作分支是 `codex/wecom-integration`。先阅读[项目首页](README.md)、[架构](docs/ARCHITECTURE.md)和涉及功能的测试。提交应说明实际问题、最终行为与验证证据。

## 准备环境

推荐Node.js 24 LTS；安装了nvm时可运行 `nvm use`。CI使用Node 24与Python 3.12，在Linux和macOS运行。

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
OFFICE_TEST_PYTHON="$PWD/.venv/bin/python" npm test
npm run check:release
npm run test:secretary
```

Windows可将Python路径换成 `.venv\Scripts\python.exe` 并设置同名环境变量。普通聊天不需要Office依赖；未安装时渲染测试会跳过。CI明确设置 `OFFICE_TEST_PYTHON`，让缺依赖变成失败而不是悄悄跳过。

测试使用模型及传输替身，可连接本机测试HTTP/WebSocket服务，不访问真实模型或企微账号。`test:secretary`输出42个运行单元的合成记录，不是42道真实模型测试题。旧QQ的 `test:e2e` 需要真实模型，不能加入无密钥CI。

## 修改约定

- 采用现有ES modules、Node内置测试和小模块，不为简单修改添加无关框架。
- 修改秘书时保持访问范围、原文档案、负责人私聊、无新增不发送、ACK后推进及取消任务的行为。
- 提示改动要保存修改前的真实输出；测试同组原版、关键事实版、无关细节版，并用未参与调试的新场景复核。
- 准确区分生成完成、结构校验、语言质量和真实投递。报告失败及未知usage，不只报成功样本均值或一个总分。
- `baseline-briefing.js`、`previous-scheduled-briefing.js`、`v2-scheduled-briefing.js` 是冻结对照，不直接修改。新增算法应保留可追溯版本。
- 不把密钥、真实员工档案、用户配置、机器路径或临时结果加入提交；小型合成场景与匿名化的研究结果可以入库。

## 更新清单

修改清单内的源码或 `docs/WECOM.md` 后执行：

```bash
npm run manifest:sync
git diff -- scripts/wecom-update-manifest.json
npm run check:release
```

该命令只刷新现有条目的哈希，不自动发现新增运行依赖。新增生产模块时，审查是否需要进入安装清单及安装器允许范围。真实清单安装测试会在临时目录执行校验并确认配置和档案不被改写。

## 提交与评审

提交前运行相关测试与 `git diff --check`。依赖更新要同步lockfile并说明必要性；不要为文档改动顺带升级全部依赖。PR描述使用仓库模板，写明复现触发、最终行为、执行的验证及尚未验证的边界。

GitHub Actions不会注入模型或企业微信密钥；实验产物是合成数据。CI通过不能代替真实模型评阅和实际企微送达验收。上传GitHub也不会自动更新用户Mac上的机器人。
