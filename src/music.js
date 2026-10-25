import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const SR = 16000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 往缓冲里叠一个音：正弦基频 + 两个泛音，带 ADSR 和一点点颤音。
 * timbre: 'hum' 更像人哼的鼻音，'pad' 更柔和。
 */
function addTone(buf, startSec, durSec, freq, gain, { attack = 0.02, release = 0.15, vibrato = 0.003, timbre = 'hum' } = {}) {
  const start = Math.floor(startSec * SR);
  const len = Math.floor(durSec * SR);
  const harmonics = timbre === 'pad' ? [1, 0.2, 0.05] : [1, 0.42, 0.18];
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= buf.length) continue;
    const t = i / SR;
    const env =
      Math.min(1, t / attack) *
      Math.min(1, (durSec - t) / release) *
      Math.exp(-t * (timbre === 'pad' ? 0.2 : 0.35));
    const vib = 1 + vibrato * Math.sin(2 * Math.PI * 5.2 * t);
    const phase = 2 * Math.PI * freq * vib * t;
    let s = 0;
    for (let h = 0; h < harmonics.length; h++) {
      s += harmonics[h] * Math.sin(phase * (h + 1));
    }
    buf[idx] += s * gain * Math.max(0, env);
  }
}

function wavBuffer(samples, sampleRate = SR) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/**
 * 程序化“哼唱”：五声音阶旋律 + 和弦铺底，每次都不一样。
 * 纯人声感旋律，默认不加任何环境音；noise>0 时叠一层很轻的海浪底噪（客服场景可开）。
 */
export function composeHum({ seconds = 24, seed = Date.now(), tempo = 84, noise = 0 } = {}) {
  const rnd = mulberry32(seed);
  const length = Math.floor(SR * seconds);
  const out = new Float32Array(length);

  const C4 = 261.63;
  const semitone = (s) => C4 * Math.pow(2, s / 12);
  const scale = [0, 2, 4, 7, 9, 12, 14, 16]; // 大调五声，跨一个八度
  const chords = [
    [0, 4, 7], // C
    [7, 11, 14], // G
    [9, 12, 16], // Am
    [5, 9, 12], // F
  ];

  const beat = 60 / tempo;
  const barLen = beat * 4;
  const bars = Math.ceil(seconds / barLen);

  // 和弦铺底（低八度）
  for (let b = 0; b < bars; b++) {
    const chord = chords[b % chords.length];
    for (const semi of chord) {
      addTone(out, b * barLen, barLen * 0.95, semitone(semi - 12), 0.05, {
        attack: 0.5,
        release: 0.8,
        vibrato: 0.0015,
        timbre: 'pad',
      });
    }
  }

  // 旋律：八分音符，带休止，偶尔长音；每 4 小节换一次音区，听起来有段落感
  const step = beat / 2;
  let t = 0;
  while (t < seconds - 0.6) {
    if (rnd() < 0.18) {
      t += step;
      continue; // 留白
    }
    const elapsedBars = t / barLen;
    const shift = Math.floor(elapsedBars / 4) % 2 === 0 ? 0 : -5;
    let semi = scale[Math.floor(rnd() * scale.length)] + shift;
    if (semi < 0) semi += 12;
    const dur = step * (rnd() < 0.22 ? 2.5 : 1);
    addTone(out, t, Math.min(dur * 0.92, seconds - t), semitone(semi), 0.16, {
      attack: 0.03,
      release: 0.18,
      vibrato: 0.004,
      timbre: 'hum',
    });
    t += step * (rnd() < 0.18 ? 2 : 1);
  }

  // 可选：很轻的海浪底噪（默认 0 = 纯哼唱）
  if (noise > 0) {
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const w = rnd() * 2 - 1;
      lp = lp * 0.985 + w * 0.015;
      const swell = 0.6 + 0.4 * Math.sin((2 * Math.PI * 0.07 * i) / SR);
      out[i] += lp * noise * swell;
    }
  }

  // 归一化 + 首尾淡入淡出
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const norm = peak > 0 ? 0.85 / peak : 1;
  const fade = Math.floor(SR * 0.4);
  for (let i = 0; i < out.length; i++) {
    let v = out[i] * norm;
    if (i < fade) v *= i / fade;
    if (i > out.length - fade) v *= (out.length - i) / fade;
    out[i] = v;
  }
  return wavBuffer(out);
}

/** 生成并落盘，返回 { file, name, bytes, ms, seconds }。 */
export function renderHum({ dir, seconds = 24, seed, tempo, noise } = {}) {
  const started = Date.now();
  const target = dir || path.join(DATA_DIR, 'audio');
  fs.mkdirSync(target, { recursive: true });
  const buf = composeHum({ seconds, seed, tempo, noise });
  const name = `hum-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`;
  const file = path.join(target, name);
  fs.writeFileSync(file, buf);
  return { file, name, bytes: buf.length, ms: Date.now() - started, seconds };
}
