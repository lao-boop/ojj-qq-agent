const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/** DeepSeek（OpenAI 兼容）对话接口。 */
export class LLM {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.logger = logger;
    this.stats = { calls: 0, promptTokens: 0, completionTokens: 0, failures: 0 };
  }

  updateConfig(cfg) {
    this.cfg = cfg;
  }

  /**
   * 发送一次对话请求。
   * 返回 { content, toolCalls, message, usage }
   */
  async chat({
    messages,
    tools,
    model = this.cfg.model,
    temperature = this.cfg.temperature,
    maxTokens = this.cfg.maxTokens,
    timeoutMs = this.cfg.timeoutMs,
    toolChoice,
    responseFormat,
    directAnswer = false,
    reasoning = false,
    retries = 4,
  }) {
    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    if (responseFormat) body.response_format = responseFormat;
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = toolChoice ?? 'auto';
    }
    if (directAnswer && new URL(this.cfg.baseUrl).hostname === 'api.deepseek.com' && /^deepseek-(v4|flash)/.test(model)) {
      body.thinking = { type: 'disabled' };
    }

    if (reasoning && new URL(this.cfg.baseUrl).hostname === 'api.deepseek.com' && /^deepseek-v4/.test(model)) {
      body.thinking = { type: 'enabled' };
    }

    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(`LLM HTTP ${res.status}：${text.slice(0, 300)}`);
          err.status = res.status;
          throw err;
        }
        const json = await res.json();
        const message = json.choices?.[0]?.message ?? {};
        const usage = json.usage ?? {};
        this.stats.calls++;
        this.stats.promptTokens += usage.prompt_tokens ?? 0;
        this.stats.completionTokens += usage.completion_tokens ?? 0;
        this.logger.debug(
          `LLM ${model} ${Date.now() - started}ms in=${usage.prompt_tokens ?? '?'} out=${usage.completion_tokens ?? '?'}`,
        );
        return {
          content: typeof message.content === 'string' ? message.content : '',
          toolCalls: message.tool_calls ?? [],
          message,
          usage,
          model,
        };
      } catch (err) {
        lastErr = err;
        this.stats.failures++;
        const retryable = !err.status || RETRYABLE.has(err.status) || err.name === 'TimeoutError';
        const cause = err.cause?.code || err.cause?.message || '';
        this.logger.warn(`LLM 请求失败（第 ${attempt + 1} 次）：${err.message}${cause ? `（${cause}）` : ''}`);
        if (!retryable || attempt === retries) break;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
