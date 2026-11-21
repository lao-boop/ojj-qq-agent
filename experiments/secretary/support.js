import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Do not persist error messages/URLs/headers from a provider or proxy: they may echo credentials.
export function requestFailure(error) {
  const causes = [];
  const seen = new Set();
  const visit = e => {
    if (!e || typeof e !== 'object' || seen.has(e) || causes.length >= 8) return;
    seen.add(e);
    const safe = v => typeof v === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(v) ? v : undefined;
    causes.push({name:safe(e.name), code:safe(e.code)});
    visit(e.cause);
    if (Array.isArray(e.errors)) e.errors.forEach(visit);
  };
  visit(error);
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  const timeout = causes.some(c=>c.name==='TimeoutError' || /TIMEOUT|TIMEDOUT/.test(c.code || ''));
  const kind = status ? 'model_http' : timeout ? 'model_timeout' : error?.name==='SyntaxError' ? 'model_protocol' : 'model_transport';
  return {kind, status, causes, message:status?`HTTP ${status}`:timeout?'模型请求超时':kind==='model_protocol'?'模型接口返回了无法解析的JSON':'模型请求失败（连接或响应读取阶段）'};
}

export async function expectAckLoss(action, sentinel) {
  try { await action(); }
  catch(error) { if (error === sentinel) return; throw error; }
  assert.fail('Expected synthetic delivery ACK loss, but the tick did not attempt delivery');
}

export function checkResume(previous, current) {
  for (const key of ['mode','algorithm','split','model','baselineCommit','requestTimeoutMs','requestAttempts','caseHash','caseSelection','variantSelection','historyMode']) assert.equal(previous[key],current[key],`Cannot reuse results with different ${key}`);
  for (const file of ['src/wecom-secretary.js','src/wecom-briefing.js','src/wecom-scheduled-briefing.js','experiments/secretary/baseline-briefing.js','experiments/secretary/cases.json']) {
    assert.ok(previous.files?.[file] && previous.files[file]===current.files[file],`Cannot reuse results after changing ${file}`);
  }
  const frozen='experiments/secretary/previous-scheduled-briefing.js';
  if(previous.files?.[frozen] || current.files?.[frozen])assert.equal(previous.files?.[frozen],current.files?.[frozen],'Frozen comparison writer changed');
  const v2='experiments/secretary/v2-scheduled-briefing.js';
  if(previous.files?.[v2] || current.files?.[v2])assert.equal(previous.files?.[v2],current.files?.[v2],'Frozen v2 changed');
  if (previous.modelOrigin && current.modelOrigin) assert.equal(previous.modelOrigin,current.modelOrigin,'Model endpoint changed');
}

export function reuseCompleted(previous, from, to, id) {
  if (!previous?.results.some(r=>r.id===id && r.status==='completed')) return false;
  assert.match(id,/^[a-z0-9-]+$/);
  const files=[`${id}.json`,`${id}-calls.json`,`${id}-archive.jsonl`];
  for(const file of files) assert.ok(fs.existsSync(path.join(from,file)),`Incomplete saved result: ${file}`);
  for(const file of files) fs.copyFileSync(path.join(from,file),path.join(to,file));
  return true;
}
