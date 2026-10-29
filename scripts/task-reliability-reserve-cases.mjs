// New inputs fixed after the first suite's findings, before fixes and before any reserve answers.
export { QUALITY_RUBRIC } from './response-quality-cases.mjs';
const fillers=Array.from({length:55},(_,i)=>({text:`储物盒第${i+1}号登记为器材${i+1}组。`}));
const multi=(id,turns,criteria,extra={})=>({id,category:'第二批未使用新题',turns:turns.map(t=>typeof t==='string'?{text:t}:t),criteria,...extra});
export const QUALITY_CASES=[
 multi('archive-note-change-keeps-day',['将保存的远岚项目集合处改成竹亭，仍然是周二集合。',{text:'远岚项目目前保存的集合处与星期是什么？只回答这两项。',restart:true,fresh:true}],['最早记忆更新成功且周二保留','重启准确回答竹亭、周二，不输出工具名称'],{seedNotes:[{text:'远岚项目在石桥集合，固定周二。'},...fillers]}),
 multi('member-note-handles',[{text:'保存我的讲义纸张偏好：米黄色。',actor:'63001'},{text:'保存我的讲义纸张偏好：浅灰色。',actor:'63002'},{text:'把我的讲义纸张偏好更正为浅绿色。',actor:'63001'},{text:'我自己的讲义纸张偏好是哪一种颜色？只说颜色。',actor:'63002',restart:true,fresh:true},{text:'我自己的讲义纸张偏好是哪一种颜色？只说颜色。',actor:'63001',fresh:true}],['甲更正为浅绿色、乙仍为浅灰色','更新工具准确选择本人有效记录']),
 multi('explicit-clock-limited-note',[{text:'请临时记到今天17:45：这次领取凭证在蓝色信封中。',clock:'2026-11-12T09:40:00Z'},{text:'现在有效记录里写了领取凭证放在哪里？',clock:'2026-11-12T09:44:00Z',restart:true,fresh:true},{text:'截止时间过了，还存在这次领取凭证位置的有效便签吗？不复述失效位置。',clock:'2026-11-12T09:46:00Z',seedNotes:fillers,restart:true,fresh:true}],['根据提供的实际时钟保存到17:45','17:44可回忆，17:46新增55条后无有效记录','不把工具名称当回答']),
 multi('deck-to-guide-after-restart',['先登记“社区种子交换”PPT草稿，共7页，暂时不要生成。',{text:'改成Word，主题改为“种子标签填写指南”，分5节；现在仍然只保留草稿。',restart:true},{text:'开始制作刚才的5节Word，每节一句通用建议，禁止配图。',delivery:'accepted'}],['旧PPT页数不阻断Word','前两轮不生成，最后实际5节新主题Word']),
 multi('guide-to-table-after-restart',['先登记Word草稿“借阅工具清单”，4节，不要执行。',{text:'把这项改成真实Excel“工坊工具台账”，3列3行：工具、数量、状态。木夹/6/可用，角尺/0/待补，锯条/2/待检。先存草稿，不生成，不加示例。',restart:true},{text:'现在制作刚才的Excel，保持原来的3列3行和数据。',delivery:'accepted'}],['旧Word节数不阻断Excel','真实3行3列，零值保留，数据无添加']),
 multi('restart-retry-original-file',[{text:'制作Word“手工纸保存建议”，3节，每节一句，不配图。',delivery:'rejected'},{text:'/retry {lastTask}',restart:true},{text:'/task {lastTask}'}],['真实文件只生成一次','明确拒绝后命令重发原文件，总共两次上传','最终接口确认上传，不声称已阅读']),
 multi('restart-unknown-retry-refused',[{text:'制作3节Word“桌游卡片整理建议”，每节一句，不配图。',delivery:'timeout'},{text:'/retry {lastTask}',restart:true},{text:'/task {lastTask}'}],['未知结果不能按明确失败重发','重启后仍未知，只有一次上传']),
 multi('tasks-visible-only-to-owner',[{text:'先登记Word草稿“公共花架清洁”，3节，等我确认再开始。',actor:'64001'},{text:'我的任务',actor:'64002',restart:true},{text:'我的任务',actor:'64001'},{text:'/cancel {lastTask}',actor:'64001'},{text:'/task {lastTask}',actor:'64001',restart:true}],['乙的列表不含甲草稿','甲可查看并取消，重启仍取消','命令不请求模型'],{group:true}),
 multi('draft-rename-keeps-defer',['先登记Word草稿“户外展牌维护”，4节，不能配图，先别开始。',{text:'把主题改成“室内展牌除尘”，其他约束照旧，继续等我确认。',restart:true},{text:'我还没让你开始；只告诉我保存的主题和当前状态。',restart:true}],['改名不触发执行','主题为室内展牌除尘，仍是草稿','零文件生成']),
 multi('three-facts-no-extra-chat',['请长期记住：发给我的活动简报用中文、日期写完整年月日、结尾不要寒暄。',{text:'只列出我保存的活动简报要求，不加解释。',restart:true,fresh:true}],['三个要求准确完整','无多余寒暄或便签条数混淆']),
];
QUALITY_CASES.find(c=>c.id==='member-note-handles').group=true;
