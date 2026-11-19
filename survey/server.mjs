import http from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = path.resolve(process.env.SURVEY_DATA || path.join(root, 'data'));
mkdirSync(data, { recursive: true, mode: 0o700 });
const keyFile = path.join(data, 'admin-key.txt');
try { writeFileSync(keyFile, randomBytes(24).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const hash = value => createHash('sha256').update(value).digest();
const admin = hash(readFileSync(keyFile, 'utf8').trim());
const dbFile = path.join(data, 'survey.sqlite');
const db = new DatabaseSync(dbFile);
chmodSync(dbFile, 0o600);
db.exec('CREATE TABLE IF NOT EXISTS responses (id TEXT PRIMARY KEY, created TEXT NOT NULL, scores TEXT NOT NULL, total INTEGER NOT NULL, good TEXT NOT NULL, improve TEXT NOT NULL)');
const items = JSON.parse(readFileSync(path.join(root, 'public/items.json')));
const assets = new Map(Object.entries({
  '/':['index.html','text/html'], '/admin':['admin.html','text/html'], '/survey.js':['survey.js','text/javascript'],
  '/admin.js':['admin.js','text/javascript'], '/style.css':['style.css','text/css'],
  '/items.json':['items.json','application/json'], '/whale.jpg':['whale.jpg','image/jpeg'],
}));
function json(res, status, body) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(body));
}
function valid(b) {
  return b && typeof b.id === 'string' && /^[a-f0-9-]{36}$/i.test(b.id) &&
    Array.isArray(b.scores) && b.scores.length === items.length &&
    b.scores.every(s => Number.isInteger(s) && s >= 0 && s <= 10) &&
    [b.good,b.improve].every(s => typeof s === 'string' && s.length <= 1000);
}
const server = http.createServer(async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  try {
    const url = new URL(req.url, 'http://survey.local').pathname;
    if (req.method === 'GET' && assets.has(url)) {
      const [file,type] = assets.get(url);
      return res.writeHead(200, {'Content-Type': type+(type.startsWith('text/')?'; charset=utf-8':'')}).end(readFileSync(path.join(root,'public',file)));
    }
    if (req.method === 'POST' && url === '/api/responses') {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res,415,{error:'请使用网页提交'});
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 20000) return json(res,413,{error:'反馈文字过长'});
        chunks.push(chunk);
      }
      let b;
      try { b=JSON.parse(Buffer.concat(chunks)); } catch { return json(res,400,{error:'提交格式无效'}); }
      if (!valid(b)) return json(res,400,{error:'请完成十项评分，文字每题最多 1000 字'});
      const scores = JSON.stringify(b.scores), total = b.scores.reduce((a,v)=>a+v,0);
      const result = db.prepare('INSERT OR IGNORE INTO responses VALUES(?,?,?,?,?,?)').run(b.id,new Date().toISOString(),scores,total,b.good,b.improve);
      if (!result.changes) {
        const old = db.prepare('SELECT scores, good, improve FROM responses WHERE id=?').get(b.id);
        if (old.scores!==scores || old.good!==b.good || old.improve!==b.improve) return json(res,409,{error:'这份答卷已提交过其他内容'});
      }
      return json(res,200,{total});
    }
    if (req.method === 'GET' && url === '/api/admin/responses') {
      const auth=req.headers.authorization || '';
      if (!auth.startsWith('Bearer ') || !timingSafeEqual(admin,hash(auth.slice(7)))) return json(res,401,{error:'管理口令不正确'});
      const rows=db.prepare('SELECT created,scores,total,good,improve FROM responses ORDER BY rowid DESC').all();
      return json(res,200,rows.map(r=>({...r,scores:JSON.parse(r.scores)})));
    }
    json(res,404,{error:'页面不存在'});
  } catch { if (!res.headersSent) json(res,500,{error:'暂时无法保存或读取数据，请稍后重试'}); }
});
const port = Number(process.env.PORT || 3020);
server.listen(port,process.env.HOST || '127.0.0.1',() => {
  const actualPort = server.address().port;
  console.log('问卷 http://127.0.0.1:'+actualPort+'   后台 http://127.0.0.1:'+actualPort+'/admin');
  console.log('管理口令保存在 '+keyFile);
});
