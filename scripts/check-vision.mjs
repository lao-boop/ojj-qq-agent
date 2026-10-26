// Uses only the local config; does not change it. One small image request.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CONFIG_PATH, DEFAULTS, deepMerge } from '../src/config.js';
import { VisionClient } from '../src/vision.js';
import { Brain } from '../src/brain.js';

const cfg = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
const independent = cfg.vision?.enabled === true;
const settings = independent ? cfg.vision : { ...cfg.llm, enabled: true, model: cfg.llm.model };
const file = path.resolve(process.argv[2] || path.join(ROOT, 'assets/sample-image.jpg'));
if (!fs.existsSync(file)) throw new Error('图片文件不存在');
const logger = { info() {}, debug() {}, warn(message) { console.error(message); } };
const vision = new VisionClient(settings, {}, logger);
const brain = new Brain({ cfg: {}, logger, llm: {}, vision });
console.log(`检测${independent ? '独立视觉' : '当前文字模型'}接口，模型：${settings.model}；图片：${file}`);
console.log('这会发起一次图片识别请求；不会自动修改配置。');
const caption = await brain.describeImages([{ file }], '准确描述图片主体和可见文字，不要猜测。');
console.log(caption);
if (caption.includes('识别未成功')) {
  console.error('检测未通过。请根据上方错误区分图片输入不支持、模型不存在、认证失败或网络问题。');
  process.exitCode = 1;
} else {
  console.log('接口返回了识别内容，请与原图核对。确认正确后，在配置向导填入该服务的 baseUrl、模型名和密钥以启用视觉。');
}
