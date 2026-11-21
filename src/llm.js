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
    // Opt-in per call: scheduled briefs defer transport retries to their durable queue.
    // Other callers keep the existing three-attempt policy.
    maxAttempts = 3,
  }) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error('Invalid model attempt limit');
    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = toolChoice ?? 'auto';
    }

    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    let lastErr;
    const attemptLog = [];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
        attemptLog.push({elapsedMs:Date.now()-started,status:res.status,ok:true});
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
          finishReason: json.choices?.[0]?.finish_reason || '',
          attempts: attemptLog,
        };
      } catch (err) {
        lastErr = err;
        this.stats.failures++;
        const code = err.cause?.code || err.code || err.name;
        attemptLog.push({elapsedMs:Date.now()-started,ok:false,...(Number.isInteger(err.status)?{status:err.status}:{}),...(typeof code==='string' && /^[A-Za-z0-9_]{1,64}$/.test(code)?{code}:{})});
        const retryable = !err.status || RETRYABLE.has(err.status) || err.name === 'TimeoutError';
        this.logger.warn(`LLM 请求失败（第 ${attempt + 1} 次）：${err.message}`);
        if (!retryable || attempt === maxAttempts - 1) break;
        await sleep(1200 * (attempt + 1));
      }
    }
    if (lastErr && typeof lastErr === 'object') lastErr.modelAttempts = attemptLog;
    throw lastErr;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
