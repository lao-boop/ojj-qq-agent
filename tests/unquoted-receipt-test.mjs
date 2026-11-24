import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DEFAULTS} from '../src/config.js';
import {WeComSecretary} from '../src/wecom-secretary.js';
const cfg=structuredClone(DEFAULTS);
cfg.wecom.botId='test';
cfg.wecom.secretary={enabled:true,ownerUserId:'leader'};
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-receipts-'));
const secretary=new WeComSecretary({cfg,dataDir,logger:console});
function receive(msgid,sender,text) {
  secretary.capture({body:{msgid,msgtype:'text',text:{content:text}}},
    {id:sender,userId:sender,group:false,receivedAt:Date.now()});
}
receive('m1','employee','隔离贴。PT-910，北区实际签收8张，已登记。');
receive('m2','employee','PT-910原录入少记1张，实数应为9张。');
const ask=s=>s.command('隔离贴，北区净数是多少？','wecom:test:private:leader');
assert.match(ask(secretary),/北区净数 9张/);
assert.equal(secretary.command('隔离贴，北区净数是多少？','wecom:test:private:employee'),null);
const restored=new WeComSecretary({cfg,dataDir,logger:console});
assert.match(ask(restored),/北区净数 9张/);
receive('p1','employee','另有明天预计4张，尚未实施。');
const plans=secretary.command('隔离贴各组合计，另列预计。','wecom:test:private:leader');
assert.match(plans,/各组合计 9张/);
assert.match(plans,/未归属预计.*预计4张/);
receive('m3','outsider','PT-910，其他库入库数量未核实。');
assert.match(ask(secretary),/合计待核/);
