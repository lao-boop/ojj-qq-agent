# 与参考交接包的对应关系

| AstrBot参考包 | 本项目 |
| --- | --- |
| plugins/、staging/ | apps/ojj-qq-agent/，独立应用；内部src、scripts、tests等保持原路径 |
| materials/ | 依据本项目当前代码编写的设计与架构说明、两份新PPT |
| tests/synthetic/ | data/scenarios/中6套已经实际使用的合成场景；应用原测试仍位于应用tests/ |
| tests/badcase_framework/ | 本项目分类、7条历史失败、评分规范及未执行验收计划 |
| evidence/ | 本项目报告、实际测试文件及本次解包复现 |
| 清单及校验 | MANIFEST.json、SHA256SUMS.txt及外部zip.sha256 |

没有套用对方项目的插件、业务SOP、企业接口、测试成绩或待办指令。原仓库增加handover/模板与scripts/build_handover.py，生成包放在tmp/；源代码内部位置不移动。打包器用于有Git元数据和历史tmp证据的原工作区；解压包用于运行、审阅和复现，不包含历史Git快照。
