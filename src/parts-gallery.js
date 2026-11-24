import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT } from './config.js';

const assets = path.join(ROOT, 'data', 'parts_gallery');
const bundledPython = path.join(os.homedir(), 'AppData', 'Local', 'AstrBot', 'backend', 'python', 'python.exe');

export async function findPartReferences(dataUrl, { previous = false } = {}) {
  const useDino = !previous && fs.existsSync(path.join(assets, 'references_dino.sqlite3'))
    && fs.existsSync(path.join(assets, 'dinov2-small-int8.onnx'));
  if (!useDino && !fs.existsSync(path.join(assets, 'references.sqlite3'))) return { labels: [] };
  const script = path.join(ROOT, 'scripts', useDino ? 'parts_gallery_dino.py' : 'parts_gallery.py');
  const python = process.env.PARTS_GALLERY_PYTHON || (fs.existsSync(bundledPython) ? bundledPython : 'python');
  return new Promise((resolve, reject) => {
    const child = execFile(python, [script], {
      windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
      env: { ...process.env, OPENBLAS_NUM_THREADS: '1' },
    }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(stdout)); } catch (err) { reject(err); }
    });
    child.stdin.on('error', reject);
    child.stdin.end(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  });
}
