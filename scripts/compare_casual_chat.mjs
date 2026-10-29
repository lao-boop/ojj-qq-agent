import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const baseline=process.argv[2];
if(!baseline)throw new Error('Pass the preserved pre-change source directory');
const results=[];
for(const [version,root] of [['before',path.resolve(baseline)],['after',process.cwd()]]){
  const {AgentManager,normalizeInput}=await import(pathToFileURL(path.join(root,'src/agents/manager.js')));
  let modelCalls=0,toolCalls=0;
  const manager=new AgentManager({llm:{async chat(){modelCalls++;return {content:'我在呢，慢慢说。'};}},tools:{specs:[],run(){toolCalls++;}}});
  const result=await manager.run({input:normalizeInput({requestText:'。',userText:'。\n【最近的文件往来】对方发来旧音频'}),messages:[{role:'system',content:'自然聊天'},{role:'user',content:'。'}],toolCtx:{chatKey:'reproduction'}});
  results.push({version,modelCalls,toolCalls,status:result.trace.status,reply:result.reply,route:result.trace.route||null});
}
const output={method:'Controlled reproduction: model always returns ordinary text, never structured task JSON. No network calls or real QQ.',results};
fs.mkdirSync('tmp',{recursive:true});fs.writeFileSync('tmp/casual-chat-mechanism-comparison.json',JSON.stringify(output,null,2));
console.log(JSON.stringify(output,null,2));
if(results[0].status!=='failed'||results[1].status!=='completed'||results[1].modelCalls!==1||results.some(r=>r.toolCalls))process.exitCode=1;
