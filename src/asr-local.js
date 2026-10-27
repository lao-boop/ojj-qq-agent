const DEFAULT_URL = 'http://127.0.0.1:8090';

/** 本地 faster-whisper 服务是否在线。 */
export async function localAsrHealthy(url = DEFAULT_URL, timeoutMs = 1500) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

/** 调本地服务转写一个音频文件。 */
export async function localTranscribe(filePath, { url = DEFAULT_URL, language = 'zh', timeoutMs = 120000 } = {}) {
  const res = await fetch(`${url}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, language }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`本地 ASR ${res.status}: ${data?.error || ''}`);
  return { text: String(data?.text || ''), ms: data?.ms || 0, language: data?.lang || language };
}
