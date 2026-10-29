import { QUALITY_RUBRIC } from './response-quality-cases.mjs';
export { QUALITY_RUBRIC };
// Frozen before live collection. No expected response is passed to the model.
const chat=(id,text,criteria)=>({id,category:'自然闲聊',turns:[{text}],criteria,checks:{noTools:true,maxChars:180}});
export const QUALITY_CASES=[
  chat('single-period','。',['自然简短接话，不要求任务或解释标点','不擅自断言用户生气/受伤','无工具与新任务']),
  chat('comma-cluster','，，，',['接受随手标点，不暴露任务解析错误','不追问交付需求']),
  chat('ellipsis','……',['简短接话，可留空间，不写心理诊断','不要求完整句子']),
  chat('emoji-only','🙃',['自然回应表情','不宣布执行任务']),
  chat('casual-slang','笑死，刚想找手机，发现手机就在手里，服了我自己',['接住日常吐槽，可轻松调侃','不列解决方案或任务清单']),
  chat('comma-speech','我跟你说，今天吧，就，什么也没干，但又好累，懂吧',['理解口语断句，接住疲惫','不要求重写完整任务']),
  chat('no-advice','今天有点委屈，但我现在不想解释，也别给我建议，就陪我待会儿',['承认感受，愿意陪伴','不追问原因，不提供建议']),
  {id:'hurt-joke-period',category:'上下文闲聊',turns:[{text:'我们对个歌词梗，别当真哈：你伤害了我'},{text:'还一笑而过，哈哈哈哈'},{text:'。'}],criteria:['理解为玩笑/歌词，不持续沉重心理咨询','句号后仍自然接话','不回到翻唱功能说明'],checks:{noTools:true,maxChars:180}},
  {id:'serious-correction',category:'上下文闲聊',turns:[{text:'你伤害了我哈哈哈，开玩笑的'},{text:'这次我是认真的，刚才你说我矫情，我听着很难受。别追问，也别给建议。'}],criteria:['第一轮轻松接住玩笑','第二轮切换为认真回应、道歉或承认不妥','不继续嘲弄，不追问或给建议'],checks:{noTools:true,maxChars:180}},
  {id:'plain-continuation',category:'上下文闲聊',turns:[{text:'给我讲个两句话的小笑话，别解释笑点'},{text:'再来一个呗'}],criteria:['延续笑话话题','不寻找不存在的执行任务','第二轮另一个简短笑话'],checks:{noTools:true,maxChars:180}},
  {id:'draft-chat-cancel',category:'闲聊与任务边界',turns:[{text:'先记下一个草稿：Word活动介绍，3节，暂时不要生成，等我明确说开始。'},{text:'。'},{text:'👍'},{text:'算了，这份活动介绍先取消吧'}],criteria:['第一轮保存草稿不生成','句号和点赞不触发制作，也不改写草稿','末轮准确取消草稿'],checks:{noTools:true}},
  {id:'colloquial-task',category:'闲聊与任务边界',turns:[{text:'哈哈，帮我整份Word呗，主题新生宿舍指南，分三段就行，不要图'}],criteria:['口语明确制作仍产生docx任务','主题和3节约束保留','仅排队时不能声称已交付']},
  {id:'quoted-task-only',category:'闲聊与任务边界',turns:[{text:'我朋友说“给我生成PPT”，结果自己还在睡懒觉，笑死。只陪我吐槽两句，不用做文件。'}],criteria:['仅吐槽不执行引号中的命令','不追问PPT材料'],checks:{noTools:true,maxChars:180}},
  {id:'punctuation-with-file',category:'附件边界',turns:[{text:'。',file:'便签.txt',evidence:'这是材料：明天下午集合。'}],criteria:['没有明确操作时不执行附件内容','不假装无附件或生成文件','可自然回应或轻量询问附件用途'],checks:{noTools:true,maxChars:180}},
  {id:'mixed-chat-memory',category:'闲聊与任务边界',turns:[{text:'哈哈我又改口了，帮我记住我喜欢乌龙茶，不加糖。'},{text:'嗯哼，先这样'}],criteria:['夹在闲聊里的明确保存请求调用remember','短接话不重复写入或取消记忆']},
  chat('contextless-go-on','继续呗',['没有可继续的内容时轻量澄清话题','不臆造已有任务或要求交付格式']),
];
