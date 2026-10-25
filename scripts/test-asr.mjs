import fs from 'node:fs';

const TOKEN = 'YOUR_REPLICATE_TOKEN';
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const FILE = 'D:\\Music\\06一人一首成名曲 100首\\879.江南-林俊杰.mp3';

const buf = fs.readFileSync(FILE);
console.log('size MB', (buf.length / 1024 / 1024).toFixed(1));
const form = new FormData();
form.append('content', new Blob([buf], { type: 'audio/mpeg' }), 'jiangnan.mp3');
const up = await fetch('https://api.replicate.com/v1/files', {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: form,
  signal: AbortSignal.timeout(300000),
}).then((r) => r.json());
const url = up.urls?.get;
console.log('uploaded', up.id, url ? 'ok' : 'NO URL');

const model = await fetch('https://api.replicate.com/v1/models/victor-upmeet/whisperx', { headers: H }).then((r) => r.json());
const version = model.latest_version.id;
const input = { audio_file: url, language: 'zh', align_output: true, batch_size: 16, task: 'transcribe' };
const created = await fetch('https://api.replicate.com/v1/predictions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ version, input }),
}).then((r) => r.json());
console.log('prediction', created.id, created.status);

const t0 = Date.now();
let p = created;
while (Date.now() - t0 < 600000) {
  await new Promise((r) => setTimeout(r, 8000));
  p = await fetch(`https://api.replicate.com/v1/predictions/${created.id}`, { headers: H }).then((r) => r.json());
  console.log(p.status, Math.round((Date.now() - t0) / 1000) + 's');
  if (['succeeded', 'failed', 'canceled'].includes(p.status)) break;
}
if (p.status !== 'succeeded') {
  console.log('FAILED', JSON.stringify(p).slice(0, 500));
  process.exit(1);
}
const out = p.output;
fs.writeFileSync('data/asr-test.json', JSON.stringify(out, null, 2));
const text = typeof out === 'string' ? out : JSON.stringify(out);
console.log('output type', typeof out, 'len', text.length);
console.log(text.slice(0, 600));
