# ojj 小鲸鱼 QQ Agent 项目交接包

生成日期：@DATE@。源码基线：`@COMMIT@`，工作分支：`@BRANCH@`。

**这是当前工作区快照，包含尚未提交的改动；不能只检出上述提交就认为得到本包代码。** 逐文件来源及哈希见 MANIFEST.json。main 未修改，未部署到真实QQ。

## 从这里开始

1. 阅读 [进度](PROGRESS.md) 和 [测试矩阵](TEST_MATRIX.md)。
2. 查看 [当前架构](materials/ARCHITECTURE.md) 与 [功能范围](materials/DESIGN.md)。
3. 按 [复现说明](REPRODUCE.md) 验证代码。
4. 查看 [最新逐题报告](evidence/task-reliability-summary.html)，历史失败也在 evidence 中。

## 目录

| 目录或文件 | 内容 |
| --- | --- |
| apps/ojj-qq-agent/ | 完整应用源码、原有测试、脚本、静态页面、配置样例和说明；内部路径保持可运行 |
| materials/ | 本项目设计与架构说明、可编辑PPT |
| data/scenarios/ | 从实际评测记录导出的合成场景JSONL |
| tests/badcase_framework/ | 本项目失败分类、评分要求、已知案例与后续验收计划 |
| evidence/ | 历史和最新报告、合成题原始回复、文件、渲染预览、本次打包验证记录 |
| scripts/ | 统一离线复现入口 |
| tools/ | 包完整性与失败案例校验器 |
| DATA_HANDLING.md | 来源、排除项目和证据边界 |
| MANIFEST.json、SHA256SUMS.txt | 文件来源与完整性校验 |

参考AstrBot包的交接组织方式；本项目是独立Node.js应用，因此使用 apps/，不伪造AstrBot插件、企业SOP、Web独立服务或未实现的业务功能。参考包中的操作指令没有作为本项目的执行要求。
