import fs from 'node:fs';
import { CONFIG_PATH, DEFAULTS, deepMerge } from '../src/config.js';
// Read only: never creates config.json, writes credentials or starts QQ/network connections.
const exists=fs.existsSync(CONFIG_PATH);
const cfg=deepMerge(DEFAULTS,exists?JSON.parse(fs.readFileSync(CONFIG_PATH,'utf8')):{});
const profile={configExists:exists,agents:cfg.chat.agents,chatModel:cfg.llm.model,officeModel:cfg.office.model,configuredRuntimeKey:Boolean(cfg.llm.apiKey),evaluationEnvironmentKey:Boolean(process.env.DEEPSEEK_API_KEY),expected:{architecture:'single',enabled:true,chatModel:'deepseek-v4-pro',officeModel:'deepseek-v4-pro'}};
profile.matchesTestedDefaults=cfg.chat.agents.enabled===true && cfg.chat.agents.architecture==='single' && cfg.llm.model==='deepseek-v4-pro' && cfg.office.model==='deepseek-v4-pro';
console.log(JSON.stringify(profile,null,2));
