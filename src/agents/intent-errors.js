export class IntentOutputError extends Error {
  constructor(code, detail) { super(detail); this.name = 'IntentOutputError'; this.code = code; }
}

/** Log categories only: no credentials, provider response bodies or conversation text. */
export function intentFailure(error, logger) {
  let code = 'service', reply = '意图理解接口暂时无法连接，这次没有启动任务，请查看连接日志后再试。';
  if (error instanceof IntentOutputError) {
    code = error.code;
    reply = '程序未能可靠解析模型返回的任务结构，重新解析一次后仍未通过校验。这次没有启动任务，请把处理对象和交付要求分开说明。';
  } else if ([401, 403].includes(error?.status)) {
    code = 'authentication'; reply = '意图理解接口认证或访问权限未通过，请检查模型服务的 API 密钥和权限；这次没有启动任务。';
  } else if (error?.status === 402) {
    code = 'quota'; reply = '意图理解接口提示额度或计费不足，请检查模型账号余额；这次没有启动任务。';
  } else if (error?.status === 429) {
    code = 'rate_limit'; reply = '意图理解接口暂时限流，请稍后再试；这次没有启动任务。';
  } else if (error?.status === 404) {
    code = 'model_or_endpoint'; reply = '意图理解接口或模型不存在，请检查模型名称和接口地址；这次没有启动任务。';
  } else if (error?.status === 400 || error?.status === 422) {
    code = 'request_parameters'; reply = '意图理解接口不接受当前请求参数，请检查模型和 JSON 输出模式兼容性；这次没有启动任务。';
  } else if (['TimeoutError', 'AbortError'].includes(error?.name)) {
    code = 'timeout'; reply = '意图理解接口响应超时，这次没有启动任务，请稍后再试。';
  }
  logger?.warn?.(`意图理解失败：code=${code}${Number.isInteger(error?.status) ? ` HTTP=${error.status}` : ''}`);
  return { failed: true, reply };
}
