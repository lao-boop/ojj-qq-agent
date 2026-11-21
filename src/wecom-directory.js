/** 企业微信通讯录：拿 access_token、按名字找 userid（用于传话）。 */
export class WeComDirectory {
  constructor({ corpId, secret, logger }) {
    this.corpId = String(corpId || '').trim();
    this.secret = String(secret || '').trim();
    this.logger = logger;
    this.token = '';
    this.expiresAt = 0;
    this.users = [];
    this.cachedAt = 0;
  }

  get enabled() {
    return Boolean(this.corpId && this.secret);
  }

  async #accessToken() {
    if (this.token && Date.now() < this.expiresAt - 60000) return this.token;
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.secret)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    if (!data?.access_token) throw new Error(`获取 access_token 失败：${data?.errmsg || data?.errcode || 'unknown'}`);
    this.token = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in || 7200) * 1000;
    return this.token;
  }

  async list() {
    if (this.users.length && Date.now() - this.cachedAt < 10 * 60 * 1000) return this.users;
    const token = await this.#accessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=${encodeURIComponent(token)}&department_id=1&fetch_child=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    if (data?.errcode) throw new Error(`读取通讯录失败：${data.errmsg}（${data.errcode}）`);
    this.users = (data.userlist || []).map((u) => ({
      userid: u.userid,
      name: u.name || u.alias || u.userid,
      alias: u.alias || '',
      mobile: u.mobile || '',
    }));
    this.cachedAt = Date.now();
    return this.users;
  }

  async resolve(query) {
    const q = String(query || '').trim();
    if (!q) return null;
    const users = await this.list();
    if (/^[A-Za-z0-9_.-]{2,64}$/.test(q)) {
      const byId = users.find((u) => u.userid === q);
      if (byId) return byId;
    }
    const exact = users.find((u) => u.name === q || u.alias === q);
    if (exact) return exact;
    const lower = q.toLowerCase();
    return (
      users.find((u) => String(u.name).toLowerCase().includes(lower) || String(u.alias).toLowerCase().includes(lower)) ||
      null
    );
  }
}
