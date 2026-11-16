import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const beijingTime = ms => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' +08:00';
const clean = (value, max = 120) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
export function messageTimes(body, receivedAt = Date.now()) {
  const seconds = body?.create_time;
  // SDK create_time is the platform event timestamp in seconds. Do not guess from text or msgid.
  const platformAt = typeof seconds === 'number' && Number.isInteger(seconds)
    && seconds >= 946684800 && seconds * 1000 <= receivedAt + 300000 ? seconds * 1000 : null;
  return { receivedAt, platformAt };
}
export function validateContacts(cfg) {
  if (cfg.directoryEnabled !== undefined && typeof cfg.directoryEnabled !== 'boolean') throw new Error('通讯录开关必须为布尔值');
  for (const k of ['corpId', 'directorySecret']) if (cfg[k] !== undefined && typeof cfg[k] !== 'string') throw new Error('通讯录凭据必须为字符串');
  if (cfg.directoryEnabled && (!cfg.corpId?.trim() || !cfg.directorySecret?.trim())) throw new Error('自动识别员工需填写企业 ID 和自建应用 Secret');
  if (!Array.isArray(cfg.contacts ?? []) || (cfg.contacts || []).length > 10000) throw new Error('员工名单最多10000人');
  const ids = new Set();
  for (const member of cfg.contacts || []) {
    if (!member || typeof member.userId !== 'string' || !member.userId || /[\s\x00-\x1f]/.test(member.userId) || member.userId.length > 128) throw new Error('员工 UserID 无效');
    if (ids.has(member.userId)) throw new Error('员工名单存在重复 UserID');
    ids.add(member.userId);
    for (const k of ['name', 'department', 'position']) {
      if (k === 'name' && (typeof member[k] !== 'string' || !member[k].trim())) throw new Error('员工姓名不能为空');
      if (member[k] !== undefined && (typeof member[k] !== 'string' || clean(member[k]) !== member[k])) throw new Error('员工姓名、部门或职务含无效字符或过长');
    }
  }
}

/** Read only. Bot credentials never authenticate the corporate directory. */
export class WeComDirectory {
  constructor({ cfg, dataDir, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { dataDir, fetchImpl, now });
    this.generation = 0;
    this.updateConfig(cfg);
  }
  updateConfig(cfg) {
    validateContacts(cfg.wecom);
    const c = cfg.wecom;
    const key = JSON.stringify([c.botId, c.corpId || '', c.directorySecret || '', !!c.directoryEnabled]);
    this.cfg = c;
    this.manual = new Map((c.contacts || []).map(p => [p.userId, { userId: p.userId, name: p.name,
      department: p.department || '', position: p.position || '', source: '管理员名单', stale: false }]));
    if (key === this.key) return;
    this.key = key; this.generation++;
    this.pending = new Map(); this.retryAt = new Map(); this.token = null; this.tokenPromise = null;
    this.departments = null; this.error = ''; this.blockedUntil = 0;
    const hash = createHash('sha256').update(key).digest('hex');
    this.file = path.join(this.dataDir, 'wecom-directory', hash + '.json');
    this.cache = new Map();
    if (fs.existsSync(this.file)) {
      try { for (const p of JSON.parse(fs.readFileSync(this.file, 'utf8'))) if (p.userId && p.name) this.cache.set(p.userId, p); }
      catch { this.error = '姓名缓存读取失败，将重新查询'; }
    }
  }
  peek(userId) {
    const manual = this.manual.get(userId);
    if (manual) return { ...manual };
    const item = this.cfg.directoryEnabled && this.cache.get(userId);
    return item ? { ...item, stale: item.checkedAt + 3600000 <= this.now() || this.retryAt.has(userId) }
      : { userId, name: '', department: '', position: '', source: '仅平台UserID', stale: false };
  }
  status() { return { enabled: !!this.cfg.directoryEnabled, configured: !!(this.cfg.corpId && this.cfg.directorySecret),
    manualCount: this.manual.size, cachedCount: this.cache.size, lastError: this.error }; }
  async request(route, params, signal) {
    const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/' + route);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const response = await this.fetchImpl(url, { signal, redirect: 'error' });
    if (!response.ok) throw new Error('通讯录接口 HTTP ' + response.status);
    const body = await response.json();
    if (Number(body.errcode || 0)) {
      const error = new Error('通讯录接口错误码 ' + Number(body.errcode));
      error.code = Number(body.errcode); throw error;
    }
    return body;
  }
  async accessToken(signal, generation) {
    if (this.token?.expires > this.now()) return this.token.value;
    if (this.tokenPromise) return this.tokenPromise;
    const cfg = this.cfg;
    const promise = this.request('gettoken', { corpid: cfg.corpId, corpsecret: cfg.directorySecret }, signal).then(body => {
      if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('通讯录令牌返回无效');
      if (generation === this.generation) this.token = { value: body.access_token, expires: this.now() + Math.max(1, (Number(body.expires_in) || 7200) - 120) * 1000 };
      return body.access_token;
    });
    this.tokenPromise = promise;
    try { return await promise; } finally { if (this.tokenPromise === promise) this.tokenPromise = null; }
  }
  async resolve(userId) {
    const known = this.peek(userId);
    if (this.manual.has(userId) || !this.cfg.directoryEnabled || (known.name && !known.stale)
      || this.blockedUntil > this.now() || (this.retryAt.get(userId) || 0) > this.now()) return known;
    if (this.pending.has(userId)) return this.pending.get(userId);
    const generation = this.generation;
    const promise = this.lookup(userId, generation);
    this.pending.set(userId, promise);
    try { return await promise; } finally { if (this.pending.get(userId) === promise) this.pending.delete(userId); }
  }
  async lookup(userId, generation) {
    const signal = AbortSignal.timeout(7000);
    try {
      let body;
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await this.accessToken(signal, generation);
        if (generation !== this.generation) return { userId, name: '', source: '仅平台UserID' };
        try { body = await this.request('user/get', { access_token: token, userid: userId }, signal); break; }
        catch (e) { if (attempt === 0 && [40014, 42001].includes(e.code)) this.token = null; else throw e; }
      }
      if (generation !== this.generation) return { userId, name: '', source: '仅平台UserID' };
      if (body.userid !== userId || !clean(body.name)) throw new Error('通讯录未返回匹配的员工姓名');
      let department = '';
      // Department lookup is optional: lack of its permission must not lose a verified name.
      try {
        if (!this.departments || this.departments.expires <= this.now()) {
          const response = await this.request('department/list', { access_token: await this.accessToken(signal, generation) }, signal);
          if (generation === this.generation) this.departments = { expires: this.now() + 3600000,
            names: new Map((response.department || []).map(d => [String(d.id), clean(d.name)])) };
        }
        department = (body.department || []).map(id => this.departments?.names.get(String(id)) || `部门ID ${id}`).join('、');
      } catch { department = (body.department || []).map(id => `部门ID ${id}`).join('、'); }
      if (generation !== this.generation) return { userId, name: '', source: '仅平台UserID' };
      const profile = { userId, name: clean(body.name), department: clean(department), position: clean(body.position),
        source: '企业通讯录', checkedAt: this.now(), stale: false };
      this.cache.set(userId, profile); this.retryAt.delete(userId); this.error = '';
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify([...this.cache.values()]), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
      return this.peek(userId);
    } catch (error) {
      if (generation !== this.generation) return { userId, name: '', source: '仅平台UserID' };
      // Never expose HTTP URLs, tokens, raw response payloads or transport exceptions.
      this.error = /^通讯录/.test(error.message) ? error.message : '通讯录暂不可用，请检查网络、应用权限和可信IP';
      this.retryAt.set(userId, this.now() + 60000);
      if (!error.code || [40001, 40013, 40014, 40054, 60020].includes(error.code)) this.blockedUntil = this.now() + 60000;
      return this.peek(userId);
    }
  }
}
