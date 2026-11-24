import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {installUpdate} from './update-wecom.mjs';

// This entry is shipped with release.json and the manifest's local payload files.
const bundle=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function main() {
  if(!process.argv[2]) throw new Error('需要指定现有机器人目录');
  const root=path.resolve(process.argv[2]);
  for(const file of ['package.json','config.json','src/wecom-main.js']) {
    if(!fs.existsSync(path.join(root,file))) throw new Error(`运行目录缺少 ${file}，未更新`);
  }
  const release=JSON.parse(fs.readFileSync(path.join(bundle,'release.json'),'utf8'));
  if(!/^[a-f0-9]{40}$/.test(release.revision)) throw new Error('更新包版本编号无效');
  const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
  let running=false;
  try {
    const res=await fetch(`http://127.0.0.1:${config.console?.port || 3010}/api/status`,{signal:AbortSignal.timeout(1000)});
    running=res.ok || res.status===401;
  } catch { /* User has stopped the bot; this is an additional local check. */ }
  if(running) throw new Error('检测到本机机器人控制台仍在运行，请停止后重试');
  const manifest=JSON.parse(fs.readFileSync(path.join(bundle,'scripts/wecom-update-manifest.json'),'utf8'));
  const result=await installUpdate({root,manifest,ownerUserId:config.wecom?.secretary?.ownerUserId || 'HuangZiMing',
    preserveConfig:true,fetchFile:name=>fs.readFileSync(path.join(bundle,name))});
  for(const item of manifest.files) {
    const actual=createHash('sha256').update(fs.readFileSync(path.join(root,item.path))).digest('hex');
    if(actual!==item.sha256)throw new Error(`安装后校验失败：${item.path}；备份：${result.backup}`);
  }
  fs.writeFileSync(path.join(result.backup,'release.json'),JSON.stringify({revision:release.revision,installedAt:new Date().toISOString(),files:manifest.files},null,2)+'\n',{mode:0o600});
  console.log(`已安装并核对版本：${release.revision}\n运行目录：${root}\n更新文件：${result.updated}\n备份：${result.backup}\n配置、密钥、聊天档案已保留。机器人尚未启动。`);
  const secretary=config.wecom?.secretary;
  console.log(`现有汇报设置：${secretary?.enabled?'启用':'未启用'}；收件人 ${secretary?.ownerUserId || '未设置'}；间隔 ${secretary?.intervalMinutes || 60} 分钟。`);
}
main().catch(error=>{console.error('更新失败：'+error.message);process.exitCode=1;});
