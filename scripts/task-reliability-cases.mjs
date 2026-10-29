// Frozen before implementation/live collection. These inputs do not reuse earlier suites.
export { QUALITY_RUBRIC } from './response-quality-cases.mjs';
const fillers=Array.from({length:48},(_,i)=>({text:`资料柜第${i+1}格的标签为归档${i+1}号。`}));
const multi=(id,turns,criteria,extra={})=>({id,category:'任务与记忆新题',turns:turns.map(t=>typeof t==='string'?{text:t}:t),criteria,...extra});
export const QUALITY_CASES=[
 multi('oldest-project-code',['我保存的栎树项目交接暗号是什么？只答暗号。'],['找回最早保存的山雀，不被后48条挤掉','只答山雀'],{seedNotes:[{text:'栎树项目的交接暗号是山雀。'},...fillers]}),
 multi('oldest-partial-correction',['将已保存的赤陶项目收件点从西门改为南门，保留它周四交接的安排。',{text:'赤陶项目保存的收件点和交接日分别是什么？',restart:true,fresh:true}],['更正最早便签且不丢周四','重启后为南门、周四'],{seedNotes:[{text:'赤陶项目收件点为西门，交接日为周四。'},...fillers]}),
 multi('expiry-after-many-notes',[{text:'暂存到今天17:20：本次检票窗口是七号窗。',clock:'2026-11-09T09:10:00Z'},{text:'有效记录里还有本次检票窗口吗？过期就说已无有效记录，不复述旧窗口。',clock:'2026-11-09T09:21:00Z',seedNotes:fillers,restart:true,fresh:true}],['到期记录失效，增加48条后也不恢复','不复述七号窗']),
 multi('two-members-interleaved-change',[{text:'请保存：我的资料导出格式偏好是PDF。',actor:'51001'},{text:'请保存：我的资料导出格式偏好是Markdown。',actor:'51002'},{text:'把我保存的导出格式改成纯文本。',actor:'51001'},{text:'我保存的导出格式是什么？只说格式。',actor:'51002',restart:true,fresh:true},{text:'我保存的导出格式是什么？只说格式。',actor:'51001',fresh:true}],['甲为纯文本，乙仍为Markdown','跨成员更改互不影响'],{group:true}),
 multi('draft-survives-two-corrections',['先建一个PPT草稿，主题“旧书修补入门”，总共6页，等我说开始再生成。',{text:'把刚才的草稿改成Word，3节，主题改为“旧书封面清洁”，仍先别做。',restart:true},{text:'现在开始制作这个Word，内容只要通用建议，不配图。',delivery:'accepted'}],['前两轮不生成','重启保留草稿，修改格式主题且继续暂缓','第三轮只生成3节新主题Word']),
 multi('ambiguous-drafts-after-restart',['先登记Word草稿“春季器材清点”，3节，暂时不要制作。','再单独登记Word草稿“秋季器材清点”，4节，暂时不要制作。',{text:'取消其中一个，先问清楚我要取消哪一个。',restart:true}],['保留两个不同草稿','先澄清，不取消任意一项、不生成文件']),
 multi('cancel-draft-never-restarts',['给我登记“雨后庭院观察”Word草稿，3节，先不执行。','取消这个待处理草稿。',{text:'刚才的草稿现在是什么状态？只报状态，不重新开始。',restart:true}],['取消状态持久化','第三轮说明已取消，零文件生成']),
 multi('group-draft-owner-boundary',[{text:'先记录Word草稿“陶艺工具收纳”，3节，不要开始。',actor:'52001'},{text:'把刚才那个草稿取消。',actor:'52002'},{text:'我的陶艺工具收纳草稿还在吗？不要执行。',actor:'52001',restart:true}],['乙不能取消甲的任务','甲重启后草稿仍待处理'],{group:true}),
 multi('failed-upload-precise-state',[{text:'做3节Word“雨伞借用登记建议”，每节一句通用建议，不配图。',delivery:'rejected'},{text:'请一句话告诉我卡在哪一步，别重新生成或发送。',restart:true}],['真实文件生成，上传明确拒绝','重启仍能查询失败阶段，只有一次上传']),
 multi('uncertain-upload-after-restart',[{text:'制作3节Word“社区棋盘保养建议”，每节一句，不配图。',delivery:'timeout'},{text:'重启之后还能确定刚才发出去了吗？不能确定就直说，别再发。',restart:true}],['重启保留结果未知','一次上传，不自动重发']),
 multi('draft-preserves-exclusions',['先保存Word草稿“纸质地图整理”，3节，禁止配图，暂缓执行。',{text:'主题改成“纸质地图防潮”，其他要求不变，依然不要执行。',restart:true},{text:'现在开始制作，3节每节一句通用建议。',delivery:'accepted'}],['保留禁图及节数','前两轮无生成，最后生成防潮主题Word']),
 multi('concise-recall-no-count-confusion',['长期保存：我的周报用中文、先写结论、最多四条。',{text:'我保存的周报要求有哪些？只列要求，不聊其他事情。',restart:true,fresh:true}],['三项事实完整','不把便签数量误说成要求数量','无无关闲聊']),
];
