import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { CONFIG_PATH, ROOT, DEFAULTS, deepMerge } from '../src/config.js';
import { validateSettings } from './friend-handover.mjs';

let failed=false;
const line=(ok,message)=>{console.log(`${ok?'OK':'FAIL'} ${message}`);if(!ok)failed=true;};
line(Number(process.versions.node.split('.')[0])>=20,`Node ${process.versions.node}`);
try{const require=createRequire(import.meta.url);require.resolve('ws');require.resolve('opencc-js');line(true,'Node依赖齐全');}
catch{line(false,'先运行setup-windows.cmd安装依赖');}
let cfg;
try{
  cfg=deepMerge(DEFAULTS,JSON.parse(fs.readFileSync(CONFIG_PATH,'utf8')));
  validateSettings({ownerQQ:cfg.access.ownerQQ,baseUrl:cfg.llm.baseUrl,model:cfg.llm.model,apiKey:cfg.llm.apiKey,wsUrl:cfg.onebot.wsUrl});
  line(true,'配置字段完整；不输出密钥');
  line(cfg.chat.agents.enabled===true&&cfg.chat.agents.architecture==='single','单主Agent模式');
  line(!fs.existsSync(path.join(ROOT,'private-import-incomplete')),'私人数据导入状态');
}catch{line(false,'配置不存在或字段无效，请运行setup-windows.cmd');}
const python=path.join(ROOT,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
try{execFileSync(python,['-c','import docx,pptx,openpyxl,pypdf,pypdfium2,PIL'],{stdio:'ignore',timeout:15000});console.log('OK 可选文档依赖齐全');}
catch{console.log('INFO 文档依赖尚未安装；文字聊天不需要，文档测试请运行install-office-windows.cmd');}
if(cfg && !failed && process.argv.includes('--online')){
  try{
    const response=await fetch(`${cfg.llm.baseUrl.replace(/\/+$/,'')}/models`,{headers:{Authorization:`Bearer ${cfg.llm.apiKey}`},signal:AbortSignal.timeout(15000)});
    if(!response.ok){line(false,`模型目录接口HTTP ${response.status}；检查服务地址、密钥或服务商是否支持/models`);await response.body?.cancel();}
    else{const body=await response.json();line(Array.isArray(body.data)&&body.data.some(m=>m.id===cfg.llm.model),'所选模型出现在服务商模型列表中');}
  }catch{line(false,'模型目录检查失败或不受支持；没有调用付费聊天，也没有修改配置');}
}
console.log('QQ是否登录、消息能否收发，请另运行diagnose-onebot-windows.cmd。');
if(failed)process.exitCode=1;
