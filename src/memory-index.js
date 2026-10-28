/**
 * 本地向量检索（稀疏向量 / TF-IDF）。
 * 不依赖模型下载：用字级 2-gram、3-gram 与英文词做特征，比单纯关键词更能扛住“换个说法”。
 */
const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '他们', '这', '那', '一个', '一下', '什么', '怎么', '就是', '还是', '然后', '因为', '所以', '但是', '可以', '没有']);

export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  const latin = s.match(/[a-z0-9]{2,}/g) || [];
  for (const w of latin) tokens.push(w);
  const han = s.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i < han.length - 1; i++) tokens.push(han.slice(i, i + 2));
  for (let i = 0; i < han.length - 2; i++) tokens.push(han.slice(i, i + 3));
  return tokens.filter((t) => t && !STOP.has(t));
}

export function buildIndex(turns) {
  const docs = turns.map((t) => tokenize(t?.content || ''));
  const df = new Map();
  for (const d of docs) {
    for (const tk of new Set(d)) df.set(tk, (df.get(tk) || 0) + 1);
  }
  const n = docs.length || 1;
  const idf = new Map();
  for (const [tk, c] of df) idf.set(tk, Math.log((n + 1) / (c + 0.5)) + 1);
  const vectors = docs.map((d) => {
    const tf = new Map();
    for (const tk of d) tf.set(tk, (tf.get(tk) || 0) + 1);
    const vec = new Map();
    let norm = 0;
    for (const [tk, c] of tf) {
      const w = (1 + Math.log(c)) * (idf.get(tk) || 1);
      vec.set(tk, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [tk, w] of vec) vec.set(tk, w / norm);
    return vec;
  });
  return { idf, vectors, n };
}

/** 返回每一轮的余弦相似度（0~1）。 */
export function vectorScores(index, query) {
  const q = tokenize(query);
  const tf = new Map();
  for (const tk of q) tf.set(tk, (tf.get(tk) || 0) + 1);
  const vec = new Map();
  let norm = 0;
  for (const [tk, c] of tf) {
    const w = (1 + Math.log(c)) * (index.idf.get(tk) || 1);
    vec.set(tk, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  const scores = new Array(index.n).fill(0);
  for (const [tk, w] of vec) {
    const qw = w / norm;
    for (let i = 0; i < index.n; i++) {
      const dw = index.vectors[i].get(tk);
      if (dw) scores[i] += qw * dw;
    }
  }
  return scores;
}
