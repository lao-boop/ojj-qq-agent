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
  }) {
    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    if (responseFormat && this.cfg.jsonMode !== false) body.response_format = responseFormat;
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = toolChoice ?? 'auto';
    }

    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 90000;
    const deadline = Date.now() + budget;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DOMException('LLM request deadline exceeded', 'TimeoutError');
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(remaining),
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
          finishReason: json.choices?.[0]?.finish_reason,
        };
      } catch (err) {
        lastErr = err;
        this.stats.failures++;
        const retryable = !err.status || RETRYABLE.has(err.status) || err.name === 'TimeoutError';
        const category = Number.isInteger(err.status) ? `HTTP=${err.status}` : ['TimeoutError', 'AbortError'].includes(err.name) ? 'timeout' : 'connection_or_response';
        this.logger.warn(`LLM 请求失败（第 ${attempt + 1} 次）：${category}`);
        if (!retryable || attempt === 2) break;
        const delay = 1200 * (attempt + 1);
        if (deadline - Date.now() <= delay) break;
        await sleep(delay);
      }
    }
    throw lastErr;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
