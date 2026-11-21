import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installUpdate } from '../scripts/update-wecom.mjs';

const bytes = Buffer.from('export const version = 2;\n');
const entry = { path: 'src/wecom-secretary.js', sha256: createHash('sha256').update(bytes).digest('hex') };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-update-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ wecom: { botId: 'keep', secret: 'local-secret' }, llm: { apiKey: 'local-key' }, tts: { pythonPath: '/custom/python' }, image: { apiKey: 'image-key' } }));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'history'), 'keep history');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ownerUserId: 'owner', manifest: { files: [entry] }, fetchFile: async () => bytes };
}
test('updater preserves secrets and history and backs up configuration while enabling requested reporting', async t => {
  const x = fixture(t);
  const result = await installUpdate(x);
  const cfg = JSON.parse(fs.readFileSync(path.join(x.root, 'config.json')));
  assert.equal(cfg.wecom.secret, 'local-secret');
  assert.equal(cfg.llm.apiKey, 'local-key');
  assert.equal(cfg.image.apiKey, 'image-key');
  assert.equal(cfg.tts.pythonPath, '/custom/python');
  assert.equal(cfg.wecom.secretary.ownerUserId, 'owner');
  assert.equal(cfg.wecom.secretary.intervalMinutes, 60);
  assert.equal(cfg.image.cooldownMs, 0);
  assert.equal(fs.readFileSync(path.join(x.root, 'data', 'history'), 'utf8'), 'keep history');
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup, 'config.json'))).wecom.secretary, undefined);
});
test('invalid hashes, paths and syntax fail before any live file or configuration changes', async t => {
  for (const change of [
    { fetchFile: async () => Buffer.from('wrong') },
    { manifest: { files: [{ ...entry, path: '../config.json' }] } },
    { manifest: { files: [entry, entry] } },
    { manifest: { files: [{ ...entry, sha256: createHash('sha256').update('invalid ! js').digest('hex') }] }, fetchFile: async () => Buffer.from('invalid ! js') },
  ]) {
    const x = fixture(t);
    const before = fs.readFileSync(path.join(x.root, 'config.json'), 'utf8');
    await assert.rejects(installUpdate({ ...x, ...change }));
    assert.equal(fs.readFileSync(path.join(x.root, 'config.json'), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(x.root, 'src', 'wecom-secretary.js')), false);
  }
});

test('document upgrade preserves existing secretary choices and Python path while adopting the main model', async t => {
  const x = fixture(t);
  const configPath = path.join(x.root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(configPath));
  cfg.wecom.secretary = { enabled: false, ownerUserId: 'existing-owner', intervalMinutes: 120 };
  cfg.office = { model: 'deepseek-flash', pythonPath: '/custom/office-python', imageDelayMs: 12000, imagesPerDeck: 0 };
  fs.writeFileSync(configPath, JSON.stringify(cfg));
  await installUpdate(x);
  const next = JSON.parse(fs.readFileSync(configPath));
  assert.deepEqual(next.wecom.secretary, cfg.wecom.secretary);
  assert.equal(next.office.pythonPath, cfg.office.pythonPath);
  assert.equal(next.office.model, '');
  assert.equal(next.office.imagesPerDeck, 0);
  assert.equal(next.office.imageDelayMs, 0);
});

test('code-only release preserves exact configuration bytes and backs them up without QQ migrations',async t=>{
  const x=fixture(t);
  const configPath=path.join(x.root,'config.json');
  const cfg=JSON.parse(fs.readFileSync(configPath));
  cfg.image.cooldownMs=12345;cfg.office={model:'deepseek-flash',imageDelayMs:12000};
  cfg.wecom.secretary={enabled:true,ownerUserId:'HuangZiMing',intervalMinutes:60};
  const original=JSON.stringify(cfg,null,4)+'\n';fs.writeFileSync(configPath,original);
  const result=await installUpdate({...x,preserveConfig:true});
  assert.equal(fs.readFileSync(configPath,'utf8'),original);
  assert.equal(fs.readFileSync(path.join(result.backup,'config.json'),'utf8'),original);
  assert.equal(fs.readFileSync(path.join(x.root,'src/wecom-secretary.js'),'utf8'),bytes.toString());
});

test('repository release manifest installs current v4 code while preserving runtime files',async t=>{
  const x=fixture(t);
  const root=path.resolve(import.meta.dirname,'..');
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'scripts/wecom-update-manifest.json'),'utf8'));
  const originalConfig=fs.readFileSync(path.join(x.root,'config.json'),'utf8');
  const result=await installUpdate({...x,manifest,preserveConfig:true,fetchFile:async file=>fs.readFileSync(path.join(root,file))});
  assert.equal(result.updated,manifest.files.length);
  for(const file of ['src/wecom-scheduled-briefing.js','src/wecom-context.js','src/llm.js','src/wecom-secretary.js']){
    assert.ok(manifest.files.some(x=>x.path===file),`${file} must ship in an incremental update`);
    assert.equal(fs.readFileSync(path.join(x.root,file),'utf8'),fs.readFileSync(path.join(root,file),'utf8'));
  }
  assert.match(fs.readFileSync(path.join(x.root,'src/wecom-scheduled-briefing.js'),'utf8'),/source-first-v4/);
  assert.equal(fs.readFileSync(path.join(x.root,'config.json'),'utf8'),originalConfig);
  assert.equal(fs.readFileSync(path.join(x.root,'data/history'),'utf8'),'keep history');
});
