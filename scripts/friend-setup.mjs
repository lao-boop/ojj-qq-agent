import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { ROOT, DEFAULTS } from '../src/config.js';
import { inspectTransfer, installOwner } from './friend-handover.mjs';

if(Number(process.versions.node.split('.')[0])<20){console.error('请安装Node.js 20以上版本，建议24 LTS。');process.exit(1);}
if(!process.stdin.isTTY){console.error('请在终端或双击setup-windows.cmd交互运行，不要把密钥作为命令参数。');process.exit(1);}
let muted=false;
const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stdout.write(chunk,encoding);callback();}});
const rl=readline.createInterface({input:process.stdin,output,terminal:true,historySize:0});
const ask=(label,initial='',secret=false)=>new Promise(resolve=>{
  muted=false;
  process.stdout.write(`${label}${initial&&!secret?` [${initial}]`:''}${secret&&initial?' [回车保留现有值]':''}: `);
  muted=secret;
  rl.question('',answer=>{muted=false;if(secret)process.stdout.write('\n');resolve(answer.trim()||initial);});
});
rl.on('SIGINT',()=>{muted=false;rl.close();console.log('\n已取消，尚未保存配置。');process.exit(130);});
try{
  console.log('接管现有机器人QQ；以下“个人QQ”填新主人的账号，不是机器人3489314835。');
  if(fs.existsSync(path.join(ROOT,'config.json')))throw new Error('此目录已有config.json。请保留它；要重新接管请使用新解压的程序目录。');
  const privateFolder=path.join(ROOT,'private-transfer');
  const transfer=fs.existsSync(privateFolder)?inspectTransfer(privateFolder):null;
  console.log(transfer?'发现私人交接包，将导入原配置和历史数据。':'没有private-transfer目录，将创建全新运行数据；现有QQ账号仍可使用。');
  const prior=transfer?.config||DEFAULTS;
  const ownerQQ=await ask('你的个人QQ号（用它给机器人发消息）');
  const ownerName=await ask('希望机器人怎样称呼你','新主人');
  const baseUrl=await ask('模型接口根地址',prior.llm?.baseUrl||DEFAULTS.llm.baseUrl);
  const model=await ask('账号支持的模型名称',prior.llm?.model||DEFAULTS.llm.model);
  const apiKey=await ask('模型API密钥（输入隐藏）',prior.llm?.apiKey||'',true);
  const wsUrl=await ask('本机OneBot正向WebSocket地址','ws://127.0.0.1:3001');
  let onebotToken=await ask('OneBot token（输入隐藏；输入 - 表示不设置）',prior.onebot?.accessToken||'',true);
  if(onebotToken==='-')onebotToken='';
  const result=installOwner({transferFolder:transfer?privateFolder:undefined,settings:{ownerQQ,ownerName,baseUrl,model,apiKey,wsUrl,onebotToken}});
  console.log(`${result.imported?'私人数据已导入。':'配置已创建。'}\n先用start-windows.cmd测试文字聊天。新主人已拥有管理权限，旧会话保持原归属。\n额外功能暂未开启；原配置保存在data/handover-original-config.json。`);
}catch(error){console.error(error.message);process.exitCode=1;}
finally{muted=false;rl.close();}
