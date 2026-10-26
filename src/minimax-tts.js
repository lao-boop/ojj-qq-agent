/** MiniMax synchronous T2A API. No automatic retries of potentially billed requests. */
export async function synthesizeMiniMax(text, cfg) {
  if (!cfg.apiKey) throw new Error('MiniMax 语音尚未配置 apiKey');
  if (!cfg.voiceId || !cfg.model) throw new Error('MiniMax 语音需要 model 和 voiceId');
  const base = (cfg.baseUrl || 'https://api.minimaxi.com').replace(/\/+$/, '');
  const response = await fetch(`${base}/v1/t2a_v2`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(cfg.timeoutMs || 60000),
    body: JSON.stringify({
      model: cfg.model, text, stream: false, output_format: 'hex',
      voice_setting: { voice_id: cfg.voiceId, speed: Number(cfg.speed ?? 1), vol: Number(cfg.volume ?? 1), pitch: Number(cfg.pitch ?? 0) },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    }),
  });
  if (!response.ok) throw new Error(`MiniMax 语音 HTTP ${response.status}`);
  const data = await response.json();
  if (data.base_resp?.status_code !== 0) {
    throw new Error(`MiniMax 语音失败（code=${data.base_resp?.status_code ?? 'missing'}）`);
  }
  const audio = data.data?.audio;
  if (typeof audio !== 'string' || !/^(?:[a-fA-F0-9]{2})+$/.test(audio)) {
    throw new Error('MiniMax 没有返回有效的十六进制音频');
  }
  const bytes = Buffer.from(audio, 'hex');
  if (bytes.length < 1000) throw new Error('MiniMax 返回的音频过短');
  return bytes;
}
