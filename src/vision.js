import { LLM } from './llm.js';

/** Separate credentials/endpoint for image input; null enabled preserves legacy configs. */
export class VisionClient {
  constructor(cfg, legacy, logger) { this.logger = logger; this.updateConfig(cfg, legacy); }
  updateConfig(cfg = {}, legacy = {}) {
    this.cfg = cfg;
    this.model = cfg.enabled == null ? legacy.visionModel : cfg.model;
    this.enabled = cfg.enabled !== false && Boolean(this.model);
    this.client = new LLM(cfg.enabled == null ? legacy : { ...cfg, temperature: 0.2 }, this.logger);
  }
  async chat(request) {
    if (!this.enabled) throw new Error('视觉识别未配置或已关闭');
    if (this.cfg.enabled === true && (!this.cfg.baseUrl || !this.cfg.apiKey)) {
      throw new Error('视觉识别缺少独立接口地址或密钥');
    }
    return this.client.chat({ ...request, model: this.model, timeoutMs: this.cfg.timeoutMs || 90000 });
  }
}
