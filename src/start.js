import { loadConfig } from './config.js';

const cfg = loadConfig();
if (cfg.platform === 'wecom') {
  const { main } = await import('./wecom-main.js');
  main();
} else if (!cfg.platform || cfg.platform === 'qq') {
  await import('./index.js');
} else {
  throw new Error('CHAT_PLATFORM / platform 只支持 qq 或 wecom');
}
