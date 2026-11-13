import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class FakeClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.connectCount = 0;
    this.disconnectCount = 0;
  }
  connect() {
    this.connectCount++;
    this.emit('connected');
    this.emit('authenticated');
  }
  disconnect() { this.disconnectCount++; }
}

test('WeCom app configuration and console integration stay local and scoped', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-app-test-'));
  const configPath = path.join(temp, 'config.json');
  const dataDir = path.join(temp, 'data');
  const envKeys = [
    'QQBOT_CONFIG', 'QQBOT_DATA', 'CHAT_PLATFORM', 'WECOM_BOT_ID', 'WECOM_BOT_SECRET',
    'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'REPLICATE_API_TOKEN',
    'ONEBOT_ACCESS_TOKEN', 'ONEBOT_WS_URL', 'CONSOLE_TOKEN',
  ];
  const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const unexpectedRequests = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

  // Prevent a developer's .env from entering the fixture when config.js is imported.
  for (const key of envKeys) process.env[key] = 'test-import-placeholder';
  process.env.QQBOT_CONFIG = configPath;
  process.env.QQBOT_DATA = dataDir;
  const { createWecomApp } = await import('../src/wecom-main.js');
  const { DEFAULTS, deepMerge } = await import('../src/config.js');
  const { wecomScope } = await import('../src/wecom-runtime.js');
  for (const key of envKeys) {
    if (!['QQBOT_CONFIG', 'QQBOT_DATA'].includes(key)) delete process.env[key];
  }

  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== '127.0.0.1') {
      unexpectedRequests.push(url.origin);
      throw new Error('External network requests are prohibited in app tests');
    }
    return originalFetch(input, options);
  };

  async function fixture(subtest, { patch = {}, env = {}, absentConfig = false } = {}) {
    for (const key of envKeys) {
      if (!['QQBOT_CONFIG', 'QQBOT_DATA'].includes(key)) delete process.env[key];
    }
    Object.assign(process.env, env);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(configPath, { force: true });
    if (!absentConfig) {
      const disk = deepMerge(structuredClone(DEFAULTS), {
        log: { level: 'error', file: false },
        console: { enabled: true, host: '127.0.0.1', port: 0, token: '' },
        image: { enabled: false }, tts: { enabled: false }, song: { enabled: false },
        ...patch,
      });
      fs.writeFileSync(configPath, JSON.stringify(disk));
    }
    const clients = [];
    const app = createWecomApp({
      clientFactory: options => {
        const client = new FakeClient(options);
        clients.push(client);
        return client;
      },
    });
    subtest.after(async () => {
      const server = app.consoleServer.server;
      const closed = server?.listening ? once(server, 'close') : null;
      app.stop();
      if (closed) await closed;
    });
    // First-start persistence is exercised before choosing a random local test port.
    app.cfg.console = { enabled: true, host: '127.0.0.1', port: 0, token: '' };
    app.cfg.log = { level: 'error', file: false };
    app.logger.setLevel('error');
    app.start();
    await once(app.consoleServer.server, 'listening');
    const base = `http://127.0.0.1:${app.consoleServer.server.address().port}`;
    const request = async (pathname, options) => {
      const response = await fetch(base + pathname, options);
      return { status: response.status, body: await response.json() };
    };
    return { app, clients, request, disk: () => JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  }

  await t.test('missing bot credentials leave the local console available without a client', async (st) => {
    const { app, clients, request } = await fixture(st);
    assert.equal(clients.length, 0);
    const { status, body } = await request('/api/status');
    assert.equal(status, 200);
    assert.equal(body.platform, 'wecom');
    assert.equal(body.wecom.state, 'unconfigured');
    assert.equal(body.wecom.connected, false);
    assert.equal(body.wecom.configured, false);
    assert.match(body.wecom.lastError, /botId.*secret/);
    await request('/api/reconnect', { method: 'POST' });
    assert.equal(clients.length, 0);
    assert.equal(app.cfg.platform, 'wecom');
  });

  await t.test('first launch keeps environment credentials out of the new config file', async (st) => {
    const { app, clients, disk } = await fixture(st, {
      absentConfig: true,
      env: {
        CHAT_PLATFORM: 'wecom', WECOM_BOT_ID: 'env-first-bot', WECOM_BOT_SECRET: 'env-first-secret',
        DEEPSEEK_API_KEY: 'env-first-llm', REPLICATE_API_TOKEN: 'env-first-replicate',
      },
    });
    assert.equal(clients.length, 1);
    assert.equal(app.cfg.wecom.secret, 'env-first-secret');
    assert.equal(app.cfg.llm.apiKey, 'env-first-llm');
    const saved = disk();
    assert.equal(saved.wecom.secret, '');
    assert.equal(saved.llm.apiKey, '');
    assert.equal(saved.song.token, '');
    assert.equal(saved.platform, 'qq');
    assert.equal(JSON.stringify(saved).includes('env-first-'), false);
    assert.equal(DEFAULTS.wecom.secret, '');
    assert.equal(DEFAULTS.llm.apiKey, '');
  });

  await t.test('masked secrets and environment overrides do not overwrite disk credentials', async (st) => {
    const { app, clients, request, disk } = await fixture(st, {
      patch: { wecom: { botId: 'disk-bot', secret: 'disk-bot-secret' }, llm: { apiKey: 'disk-llm-secret' } },
      env: {
        WECOM_BOT_SECRET: 'environment-bot-secret', DEEPSEEK_API_KEY: 'environment-llm-secret',
        REPLICATE_API_TOKEN: 'environment-replicate-secret',
      },
    });
    const publicConfig = (await request('/api/config')).body.config;
    const patch = { chat: { maxBubbles: 2 } };
    for (const [section, key] of [
      ['wecom', 'secret'], ['llm', 'apiKey'], ['image', 'apiKey'],
      ['song', 'token'], ['voice', 'token'], ['asr', 'token'],
    ]) {
      assert.match(publicConfig[section][key], /••••/);
      patch[section] = { [key]: publicConfig[section][key] };
    }
    const saved = await request('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch }),
    });
    assert.equal(saved.status, 200);
    assert.equal(app.cfg.wecom.secret, 'environment-bot-secret');
    assert.equal(app.cfg.llm.apiKey, 'environment-llm-secret');
    assert.equal(disk().wecom.secret, 'disk-bot-secret');
    assert.equal(disk().llm.apiKey, 'disk-llm-secret');
    assert.equal(disk().chat.maxBubbles, 2);
    assert.equal(JSON.stringify(disk()).includes('environment-'), false);
    assert.equal(JSON.stringify(disk()).includes('••••'), false);
    assert.equal(clients.length, 1);
    await app.applyConfig({ wecom: { secret: 'new-explicit-disk-secret' } });
    assert.equal(disk().wecom.secret, 'new-explicit-disk-secret');
    assert.equal(app.cfg.wecom.secret, 'environment-bot-secret');
    assert.equal(clients.length, 1, 'an unchanged effective credential must not reconnect');
  });

  await t.test('changing bot credentials hot-reloads the transport and preserves plain config updates', async (st) => {
    const { app, clients, disk } = await fixture(st, {
      patch: { wecom: { botId: 'bot-A', secret: 'secret-A' } },
    });
    assert.equal(clients.length, 1);
    assert.equal(app.status().wecom.connected, true);
    await app.applyConfig({ chat: { maxBubbles: 2 } });
    assert.equal(clients.length, 1);
    assert.equal(app.brain.cfg.maxBubbles, 2);
    await app.applyConfig({ wecom: { botId: 'bot-B', secret: 'secret-B' } });
    assert.equal(clients.length, 2);
    assert.equal(clients[0].disconnectCount, 1);
    assert.equal(clients[1].connectCount, 1);
    assert.equal(clients[1].options.botId, 'bot-B');
    assert.equal(clients[1].options.secret, 'secret-B');
    assert.equal(app.status().wecom.botId, 'bot-B');
    assert.equal(app.status().wecom.connected, true);
    assert.equal(disk().wecom.secret, 'secret-B');
    const before = fs.readFileSync(configPath, 'utf8');
    await assert.rejects(app.applyConfig({ wecom: { mode: 'invalid' } }), /权限模式/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    assert.equal(app.cfg.wecom.mode, 'open');
    assert.equal(clients.length, 2);
  });

  await t.test('console list, read, and delete APIs expose only the current WeCom bot scope', async (st) => {
    const botId = 'bot:scope';
    const { app, request } = await fixture(st, {
      patch: { wecom: { botId, secret: 'scope-secret' } },
    });
    const ownKey = `${wecomScope(botId)}private:Alice_001`;
    const foreignKeys = ['private:12345', 'wecom:other-bot:private:Alice_001', 'wecom:bot%3Ascope-suffix:private:Alice_001'];
    app.memory.append(ownKey, 'user', 'current bot memory', 'current bot');
    for (const key of foreignKeys) app.memory.append(key, 'user', 'private foreign memory', 'foreign');
    assert.deepEqual((await request('/api/sessions')).body.sessions.map(item => item.key), [ownKey]);
    assert.deepEqual((await request('/api/status')).body.sessions.map(item => item.key), [ownKey]);
    assert.equal((await request('/api/session?key=' + encodeURIComponent(ownKey))).body.session.turns[0].content, 'current bot memory');
    for (const key of foreignKeys) {
      const url = '/api/session?key=' + encodeURIComponent(key);
      const read = await request(url);
      assert.equal(read.status, 400);
      assert.equal(read.body.ok, false);
      assert.equal(JSON.stringify(read.body).includes('private foreign memory'), false);
      assert.equal((await request(url, { method: 'DELETE' })).status, 400);
      assert.equal(app.memory.get(key).turns.length, 1);
    }
    assert.equal((await request('/api/session?key=' + encodeURIComponent(ownKey), { method: 'DELETE' })).status, 200);
    assert.equal((await request('/api/sessions')).body.sessions.length, 0);
    await app.applyConfig({ wecom: { botId: 'other-bot' } });
    const visible = (await request('/api/sessions')).body.sessions.map(item => item.key);
    assert.deepEqual(visible, ['wecom:other-bot:private:Alice_001']);
  });

  assert.deepEqual(unexpectedRequests, []);
});
