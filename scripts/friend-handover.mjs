import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CONFIG_PATH, DATA_DIR, ROOT, DEFAULTS, deepMerge } from '../src/config.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function copyTree(source, dest, skipped = []) {
  const relative=path.relative(path.resolve(source),path.resolve(dest));
  if(!relative || (relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative)))throw new Error('交接输出目录不能位于被复制的目录内。');
  for (const item of fs.readdirSync(source, {withFileTypes:true})) {
    const src=path.join(source,item.name), target=path.join(dest,item.name);
    if(item.isSymbolicLink()){skipped.push(src);continue;}
    if(item.isDirectory()){fs.mkdirSync(target,{recursive:true});copyTree(src,target,skipped);}
    else if(item.isFile()){fs.mkdirSync(dest,{recursive:true});fs.copyFileSync(src,target);}
  }
}
function filesIn(root, prefix='') {
  return fs.readdirSync(path.join(root,prefix),{withFileTypes:true}).flatMap(item=>{
    const rel=prefix?`${prefix}/${item.name}`:item.name;
    if(item.isSymbolicLink())throw new Error('交接目录含符号链接，停止导入。');
    return item.isDirectory()?filesIn(root,rel):item.isFile()?[rel]:[];
  });
}
export function exportPrivate({configPath=CONFIG_PATH,dataDir=DATA_DIR,sourceRoot=ROOT,outParent=os.homedir()}={}) {
  if(!fs.existsSync(configPath))throw new Error('没有找到运行配置；请在原来运行机器人的项目目录导出。');
  let config;try{config=JSON.parse(fs.readFileSync(configPath,'utf8'));}catch{throw new Error('配置文件不是有效JSON，未导出。');}
  const folder=path.join(outParent,`ojj-private-transfer-${new Date().toISOString().slice(0,10)}-${randomUUID().slice(0,8)}`);
  fs.mkdirSync(folder,{recursive:false,mode:0o700});
  fs.copyFileSync(configPath,path.join(folder,'config.json'));fs.chmodSync(path.join(folder,'config.json'),0o600);
  const skipped=[];
  if(fs.existsSync(dataDir))copyTree(dataDir,path.join(folder,'data'),skipped);
  const library=config.library?.dir;
  const libraryPath=library?path.resolve(sourceRoot,library):'';
  let copiedLibrary=false;
  if(libraryPath && fs.existsSync(libraryPath) && fs.statSync(libraryPath).isDirectory()){
    copyTree(libraryPath,path.join(folder,'external','music'),skipped);copiedLibrary=true;
  }
  const manifest={version:1,createdAt:new Date().toISOString(),sourceRoot,sourceDataDir:dataDir,
    includes:['config.json','data (including conversations, persona, memories, task and delivery records)',...(copiedLibrary?['external/music']:[])],
    copiedLibrary,skippedSymlinks:skipped,accountLoginIncluded:false,
    missingLibrary:Boolean(library && !copiedLibrary),
    note:'PRIVATE: contains API credentials and conversation data. Transfer only to the new owner; never upload to the public repository.',
    files:Object.fromEntries(filesIn(folder).map(rel=>[rel,hash(fs.readFileSync(path.join(folder,rel)))]))};
  fs.writeFileSync(path.join(folder,'TRANSFER.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  return {folder,files:Object.keys(manifest.files).length,manifest};
}
export function inspectTransfer(folder) {
  let manifest,config;
  try{manifest=JSON.parse(fs.readFileSync(path.join(folder,'TRANSFER.json'),'utf8'));config=JSON.parse(fs.readFileSync(path.join(folder,'config.json'),'utf8'));}
  catch{throw new Error('私人交接目录缺少有效的TRANSFER.json或config.json。');}
  if(manifest.version!==1 || !manifest.files || typeof manifest.files!=='object' || !manifest.files['config.json'])throw new Error('不支持的私人交接清单。');
  const actual=filesIn(folder).filter(f=>f!=='TRANSFER.json');
  if(actual.length!==Object.keys(manifest.files).length)throw new Error('私人交接文件数量与清单不一致。');
  for(const rel of actual){
    if(!Object.hasOwn(manifest.files,rel)||hash(fs.readFileSync(path.join(folder,rel)))!==manifest.files[rel])throw new Error('私人交接文件校验失败，未导入。');
  }
  return {manifest,config};
}
export function validateSettings({ownerQQ,baseUrl,model,wsUrl,apiKey}) {
  if(!/^[1-9]\d{4,11}$/.test(ownerQQ))throw new Error('接管人的个人QQ号应为5至12位数字，不要填机器人QQ号。');
  for(const [value,schemes,label] of [[baseUrl,['https:','http:'],'模型地址'],[wsUrl,['ws:','wss:'],'OneBot地址']]){
    let url;try{url=new URL(value);}catch{throw new Error(`${label}格式不正确。`);}
    if(!schemes.includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error(`${label}请只填写接口地址，令牌另外填写。`);
  }
  if(!model?.trim()||model.length>200)throw new Error('请填写服务商实际支持的模型名称。');
  if(!apiKey?.trim()||/^(YOUR_|填|示例)/i.test(apiKey))throw new Error('没有有效的模型API密钥。');
}
export function makeOwnerConfig(settings, original={}) {
  validateSettings(settings);
  const cfg=deepMerge(DEFAULTS,original);
  cfg.llm={...cfg.llm,baseUrl:settings.baseUrl,apiKey:settings.apiKey,model:settings.model};
  cfg.office={...cfg.office,model:settings.model,pythonPath:'.venv/Scripts/python.exe'};
  cfg.files={...cfg.files,pythonPath:'.venv/Scripts/python.exe',pathMappings:[]};
  cfg.tts={...cfg.tts,pythonPath:'.venv/Scripts/python.exe'};
  cfg.asr.local={...cfg.asr.local,pythonPath:'.venv/Scripts/python.exe'};
  cfg.onebot={...cfg.onebot,wsUrl:settings.wsUrl,accessToken:settings.onebotToken||'',httpUrl:''};
  cfg.access={...cfg.access,mode:'whitelist',ownerQQ:settings.ownerQQ,adminQQ:[settings.ownerQQ],privateAllow:[settings.ownerQQ],groupAllow:[],allowAllWhenEmpty:false,autoAcceptFriend:false,autoAcceptGroupInvite:false};
  cfg.chat.agents={...cfg.chat.agents,enabled:true,architecture:'single'};
  cfg.chat.group={...cfg.chat.group,chanceReply:0};
  // Preserve provider settings, but start with text until Windows dependencies are installed.
  for(const key of ['image','tts','song','voice','library','asr','vision','qzone','relay'])cfg[key]={...cfg[key],enabled:false};
  cfg.asr.local.enabled=false;
  cfg.console={...cfg.console,enabled:false,host:'127.0.0.1'};
  return cfg;
}
function rewriteDataPaths(dataDir, oldDir) {
  if(typeof oldDir!=='string'||!oldDir)return;
  const old=oldDir.replace(/\\/g,'/').replace(/\/$/,'');
  const mapped=value=>{
    if(typeof value!=='string')return value;
    const normalized=value.replace(/\\/g,'/');
    if(!normalized.startsWith(`${old}/`))return value;
    const suffix=normalized.slice(old.length+1);
    if(suffix.split('/').includes('..'))return value;
    return path.join(dataDir,...suffix.split('/'));
  };
  for(const [file,field] of [['media-log.json','path'],['office-deliveries.json','file']]){
    const target=path.join(dataDir,file);if(!fs.existsSync(target))continue;
    const rows=JSON.parse(fs.readFileSync(target,'utf8'));
    if(!Array.isArray(rows))throw new Error('历史媒体或交付日志格式异常，停止导入。');
    for(const row of rows)if(row&&typeof row==='object')row[field]=mapped(row[field]);
    fs.writeFileSync(target,JSON.stringify(rows,null,2));
  }
}
export function installOwner({root=ROOT,transferFolder,settings}) {
  const configFile=path.join(root,'config.json'),data=path.join(root,'data');
  if(fs.existsSync(configFile)||fs.existsSync(path.join(root,'private-import-incomplete')))throw new Error('此目录已有配置或未完成的导入；请使用新解压的程序目录，避免覆盖现有机器人。');
  if(fs.existsSync(data)&&fs.readdirSync(data).some(x=>x!=='knowledge'))throw new Error('此目录已有运行数据；请使用新解压的程序目录。');
  const transfer=transferFolder?inspectTransfer(transferFolder):null;
  const config=makeOwnerConfig(settings,transfer?.config||{});
  // Marker prevents a partial copy from being mistaken for a completed migration.
  const marker=path.join(root,'private-import-incomplete');fs.writeFileSync(marker,'Import did not finish; retry in a fresh extracted directory.');
  if(transfer){
    if(fs.existsSync(path.join(transferFolder,'data')))copyTree(path.join(transferFolder,'data'),data);
    if(transfer.manifest.copiedLibrary){copyTree(path.join(transferFolder,'external','music'),path.join(data,'music'));config.library.dir='data/music';}
    rewriteDataPaths(data,transfer.manifest.sourceDataDir);
  }
  fs.mkdirSync(data,{recursive:true});
  const globalFile=path.join(data,'global.json');
  if(fs.existsSync(globalFile)){
    const global=JSON.parse(fs.readFileSync(globalFile,'utf8'));
    fs.copyFileSync(globalFile,path.join(data,'handover-original-global.json'));
    global.owner={name:settings.ownerName||'新主人',aliases:[],likes:[],relation:'此机器人的现任主人'};
    fs.writeFileSync(globalFile,JSON.stringify(global,null,2));
  }
  fs.writeFileSync(path.join(data,'handover-original-config.json'),JSON.stringify(transfer?.config||{},null,2),{mode:0o600});
  fs.writeFileSync(configFile,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});
  fs.unlinkSync(marker);
  return {imported:Boolean(transfer),configFile};
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    if(process.argv[2]!=='export')throw new Error('用法：node scripts/friend-handover.mjs export');
    console.log('请先停止旧机器人。本地导出配置、密钥、记忆、聊天记录和可找到的曲库；不上传任何内容。');
    const result=exportPrivate();
    let zip='';
    if(process.platform==='darwin'){
      zip=`${result.folder}.zip`;
      execFileSync('/usr/bin/ditto',['-c','-k','--keepParent',result.folder,zip],{stdio:'ignore'});
    }
    console.log(`导出完成：${zip||result.folder}\n文件数：${result.files}\n这是私人交接包，请直接私下交给接管人，不要上传公开仓库。`);
    if(result.manifest.missingLibrary)console.log('配置里的曲库目录没有找到；请另行确认原电脑上的音乐文件位置。');
    if(result.manifest.skippedSymlinks.length)console.log(`有${result.manifest.skippedSymlinks.length}个符号链接未复制，详情在私人包内TRANSFER.json。`);
  }catch{console.error('私人导出未完成。请确认已停止机器人、在原项目目录运行、config.json有效且磁盘可写；未上传任何文件。');process.exitCode=1;}
}
