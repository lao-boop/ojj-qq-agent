import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.REPLICATE_API_TOKEN || 'YOUR_REPLICATE_TOKEN';
const DATASET = process.argv[2] || 'data/voice-dataset/xiaoyi.zip';
const OUT = process.argv[3] || 'data/voice-dataset/train-result.json';
const EPOCHS = Number(process.argv[4] || 15);

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

function save(obj) {
  fs.writeFileSync(OUT, JSON.stringify(obj, null, 2));
  console.log(JSON.stringify(obj).slice(0, 400));
}

async function upload() {
  const buf = fs.readFileSync(DATASET);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now();
    try {
      const form = new FormData();
      form.append('content', new Blob([buf], { type: 'application/zip' }), path.basename(DATASET));
      const res = await fetch('https://api.replicate.com/v1/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: form,
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`upload ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
      console.log('uploaded in', Math.round((Date.now() - started) / 1000) + 's:', data.id);
      return data.urls?.get;
    } catch (err) {
      console.warn(`upload attempt ${attempt} failed (${Math.round((Date.now() - started) / 1000)}s):`, err.message);
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  const zipUrl = await upload();
  save({ stage: 'uploaded', zipUrl, startedAt: new Date().toISOString() });

  const version = '0397d5e28c9b54665e1e5d29d5cf4f722a7b89ec20e9dbf31487235305b1a101';
  const input = {
    dataset_zip: zipUrl,
    epoch: EPOCHS,
    version: 'v2',
    f0method: 'rmvpe_gpu',
    batch_size: '7',
    sample_rate: '48k',
  };
  const created = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ version, input }),
  }).then((r) => r.json());
  console.log('prediction:', created.id, created.status);
  save({ stage: 'training', id: created.id, status: created.status, startedAt: new Date().toISOString() });

  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  let p = created;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30000));
    p = await fetch(`https://api.replicate.com/v1/predictions/${created.id}`, { headers: H }).then((r) => r.json());
    console.log(new Date().toLocaleTimeString(), p.status, p.logs ? String(p.logs).slice(-100) : '');
    save({ stage: 'training', id: p.id, status: p.status, output: p.output, error: p.error, updatedAt: new Date().toISOString() });
    if (p.status === 'succeeded' || p.status === 'failed' || p.status === 'canceled') break;
  }
  save({ stage: 'done', id: p.id, status: p.status, output: p.output, error: p.error, finishedAt: new Date().toISOString() });
}

main().catch((e) => {
  console.error('FAILED', e.message);
  save({ stage: 'error', error: e.message, at: new Date().toISOString() });
  process.exit(1);
});
