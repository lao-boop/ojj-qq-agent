// Check by default; --write refreshes only the hashes of existing release entries.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2);
if(args.some(a=>a!=='--write'))throw new Error('Usage: node scripts/sync-wecom-manifest.mjs [--write]');
const root=path.resolve(import.meta.dirname,'..');
const file=path.join(root,'scripts/wecom-update-manifest.json');
const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
const changed=[];
for(const entry of manifest.files){
  const source=path.resolve(root,entry.path);
  if(!source.startsWith(root+path.sep))throw new Error('Invalid manifest path');
  const hash=createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if(hash!==entry.sha256){changed.push(entry.path);entry.sha256=hash;}
}
if(args.includes('--write')){
  fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
  console.log(`Updated ${changed.length} hashes; review the manifest diff.`);
}else if(changed.length){
  console.error(`Stale release hashes:\n${changed.join('\n')}\nRun npm run manifest:sync after reviewing source changes.`);
  process.exitCode=1;
}else console.log(`Release manifest verified: ${manifest.files.length} files.`);
