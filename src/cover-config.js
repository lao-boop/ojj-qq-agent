export function coverConfigurationIssue(cfg = {}) {
  if (!cfg.enabled) return '翻唱开关尚未开启，请先运行本地翻唱配置向导。';
  if (!cfg.token || /^YOUR_|^填入/.test(cfg.token)) return '尚未配置翻唱服务的 Replicate API token；MiniMax 朗读密钥不能代替它。';
  if (!cfg.rvcModel) return '尚未选择翻唱目标音色。';
  if (cfg.rvcModel === 'CUSTOM' && !cfg.customModelUrl) return '选择了自定义 RVC 音色，但还没有提供模型下载地址。';
  if (cfg.customModelUrl && !/^https:\/\//i.test(cfg.customModelUrl)) return '自定义 RVC 模型需要服务端可下载的 HTTPS 地址。';
  return '';
}

/** A narrow capability question is not authorization to generate or upload audio. */
export function coverCapabilityReply(text, voice, songEnabled = false) {
  if (!/^(?:你(?:现在)?)?(?:会不会|能不能|能否)(?:唱歌|翻唱|变声)[？?吗呀啊呢]*$/.test(String(text || '').trim())) return '';
  const issue = coverConfigurationIssue(voice);
  const cover = issue ? `目前翻唱还不能执行：${issue}` : `已配置翻唱声线「${voice.rvcModel}」。你可以提供要翻唱的音频，实际是否成功以服务结果为准。`;
  return `${cover}${songEnabled ? '另外已配置原创歌曲生成。' : ''}朗读、原创歌曲和翻唱是不同功能。`;
}
