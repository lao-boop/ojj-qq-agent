// Hosted edition: the questionnaire and the password-protected admin share one origin.
import items from './public/items.json';

const json = (value, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});

async function authorized(request, key) {
  const auth = request.headers.get('Authorization') || '';
  if (!key || key.length < 16 || !auth.startsWith('Bearer ')) return false;
  const digest = text => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const [expected, received] = await Promise.all([digest(key), digest(auth.slice(7))]);
  return crypto.subtle.timingSafeEqual(expected, received);
}

async function saveResponse(request, db) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') return json({error:'提交格式无效'}, 415);
  const chunks = [];
  let size = 0;
  if (!request.body) return json({error:'请填写答卷'}, 400);
  for await (const chunk of request.body) {
    size += chunk.length;
    if (size > 20000) return json({error:'反馈文字过长'}, 413);
    chunks.push(chunk);
  }
  let b;
  try { b = JSON.parse(await new Blob(chunks).text()); }
  catch { return json({error:'提交格式无效'}, 400); }
  if (!b || typeof b.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(b.id) ||
      !Array.isArray(b.scores) || b.scores.length !== items.length ||
      !b.scores.every(s => Number.isInteger(s) && s >= 0 && s <= 10) ||
      ![b.good, b.improve].every(s => typeof s === 'string' && s.length <= 1000)) {
    return json({error:'请完成十项评分，文字每题最多 1000 字'}, 400);
  }
  const scores = JSON.stringify(b.scores), total = b.scores.reduce((a,s)=>a+s,0);
  const result = await db.prepare('INSERT OR IGNORE INTO responses VALUES (?, ?, ?, ?, ?, ?)')
    .bind(b.id, new Date().toISOString(), scores, total, b.good, b.improve).run();
  if (!result.meta.changes) {
    const previous = await db.prepare('SELECT scores, good, improve FROM responses WHERE id=?').bind(b.id).first();
    if (previous?.scores !== scores || previous.good !== b.good || previous.improve !== b.improve)
      return json({error:'这份答卷已提交过其他内容'},409);
  }
  return json({total});
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      const admin = request.method === 'GET' && path === '/api/admin/responses';
      if (!admin && !(request.method === 'POST' && path === '/api/responses')) return json({error:'页面不存在'},404);
      if (admin && !await authorized(request,env.ADMIN_KEY)) return json({error:'请检查后台口令（至少 16 位）'},401);
      await env.DB.exec('CREATE TABLE IF NOT EXISTS responses (id TEXT PRIMARY KEY, created TEXT NOT NULL, scores TEXT NOT NULL, total INTEGER NOT NULL, good TEXT NOT NULL, improve TEXT NOT NULL)');
      if (!admin) return await saveResponse(request, env.DB);
      const {results} = await env.DB.prepare('SELECT created,scores,total,good,improve FROM responses ORDER BY rowid DESC').all();
      return json(results.map(r=>({...r,scores:JSON.parse(r.scores)})));
    } catch { return json({error:'暂时无法保存或读取数据，请稍后重试'},500); }
  }
};
