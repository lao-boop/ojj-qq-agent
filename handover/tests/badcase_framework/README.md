# 失败案例框架

本项目标签：media_ownership（文件归属）、memory_lifecycle（记忆生命周期）、task_persistence（任务持久化）、format_transition（格式切换）、tool_protocol（工具协议）、reference_binding（记录绑定）、temporal_intent（时间理解）、latency（时延）、presentation（表达排版）。

S1：阻断核心任务；S2：可能造成错误归属、状态或操作；S3：表达、排版、延迟等体验问题。标签说明观察到的故障，不用猜测的模型心理作为根因。

cases.json 保留原始失败结论；resolution 字段记录修复及验证方式。另一道新题通过不自动改写原题结果。JSON Schema描述字段；tools/validate_handover.py检查必填字段、标签、证据文件和包哈希。

六维评分规则与旧报告一致：每维0～2，总分至少10且无0分、无关键错误才达标；服务异常单列，所有尝试均保留。不能把单元测试与模型题数相加。
