import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import vec3Pkg from 'vec3';

const { pathfinder, Movements, goals } = pathfinderPkg;
const Vec3 = vec3Pkg.Vec3 || vec3Pkg;

/**
 * 让机器人进 Minecraft（Java 版）陪玩。
 * 只做最小集：连接、状态、走、挖、说、看背包、下线。
 */
export class Minecraft {
  constructor({ cfg = {}, logger, onChat } = {}) {
    this.cfg = cfg || {};
    this.logger = logger;
    this.onChat = onChat;
    this.bot = null;
    this.connecting = false;
  }

  get online() {
    return Boolean(this.bot?.entity);
  }

  #require() {
    if (!this.online) throw new Error('还没进服，先 mc_connect');
    return this.bot;
  }

  async connect({ host, port = 25565, username, version } = {}) {
    if (this.online) return this.status();
    if (this.connecting) throw new Error('正在连接，等一下');
    this.connecting = true;
    const name = String(username || this.cfg.username || 'Xiaojingyu').slice(0, 16);
    try {
      const bot = mineflayer.createBot({
        host: String(host || this.cfg.host || '127.0.0.1'),
        port: Number(port || this.cfg.port || 25565),
        username: name,
        auth: 'offline',
        version: version || this.cfg.version || '26.1',
        hideErrors: true,
      });
      bot.loadPlugin(pathfinder);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('连接超时（20 秒）')), 20000);
        bot.once('spawn', () => {
          clearTimeout(timer);
          resolve();
        });
        bot.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        bot.once('kicked', (reason) => {
          clearTimeout(timer);
          reject(new Error(`被服务器踢出：${typeof reason === 'string' ? reason : JSON.stringify(reason).slice(0, 120)}`));
        });
      });
      this.bot = bot;
      bot.on('end', () => {
        this.logger?.info?.('MC 连接结束');
        this.bot = null;
      });
      bot.on('error', (err) => this.logger?.warn?.(`MC 错误：${err.message}`));
      bot.on('chat', (username, message) => {
        if (!username || username === bot.username) return;
        try { this.onChat?.(String(username), String(message || '').slice(0, 300)); } catch (err) { this.logger?.warn?.(`MC 聊天处理失败：${err.message}`); }
      });
      const movements = new Movements(bot);
      movements.canDig = true;
      movements.allow1by1towers = true;
      movements.maxDropDown = 8;
      bot.pathfinder.setMovements(movements);
      // 饿了自动吃（每 15 秒看一次）
      clearInterval(this.autoTimer);
      this.autoTimer = setInterval(() => {
        if (!this.online || this.eating) return;
        if ((bot.food ?? 20) >= 16) return;
        this.eating = true;
        this.eatIfHungry()
          .then((r) => r.ate && this.logger?.info?.('饿了，吃了一口'))
          .catch(() => {})
          .finally(() => {
            this.eating = false;
          });
      }, 15000);
      this.autoTimer.unref?.();
      clearInterval(this.defendTimer);
      this.defendTimer = setInterval(() => {
        if (!this.online || this.defending) return;
        try {
          const hostile = /zombie|skeleton|creeper|spider|enderman|witch|pillager|drowned|husk|stray|slime|phantom|blaze|ghast|magma|silverfish|vex|vindicator|evoker|ravager|wither_skeleton|guardian|shulker/;
          const near = Object.values(this.bot.entities || {}).find(
            (e) => e && e.type === 'mob' && hostile.test(e.name || '') && e.position.distanceTo(this.bot.entity.position) < 6,
          );
          if (!near) return;
          this.defending = true;
          this.logger?.info?.('附近有怪，自动反击');
          this.attack(near.name)
            .catch(() => {})
            .finally(() => {
              this.defending = false;
            });
        } catch {
          this.defending = false;
        }
      }, 2000);
      this.defendTimer.unref?.();
      bot.once('end', () => clearInterval(this.defendTimer));
      bot.once('end', () => clearInterval(this.autoTimer));
      await this.#settleOnGround().catch(() => {});
      this.logger?.info?.(`已进入 MC：${name}@${host}:${port}`);
      return this.status();
    } finally {
      this.connecting = false;
    }
  }

  status() {
    const bot = this.#require();
    const pos = bot.entity.position;
    return {
      username: bot.username,
      position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
      health: Math.round(bot.health ?? 0),
      food: Math.round(bot.food ?? 0),
      dimension: bot.game?.dimension || '',
      players: Object.keys(bot.players || {}).filter((p) => p !== bot.username).slice(0, 10),
      timeOfDay: bot.time?.timeOfDay ?? null,
      heldItem: bot.heldItem?.name || '空手',
    };
  }

  async moveTo(x, y, z) {
    const bot = this.#require();
    const goal = new goals.GoalNear(Number(x), Number(y), Number(z), 1);
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise((_, reject) => setTimeout(() => reject(new Error('走过去超时（20 秒）')), 20000)),
    ]);
    return this.status();
  }

  async dig(name, count = 1) {
    const bot = this.#require();
    const id = bot.registry?.blocksByName?.[name]?.id;
    if (id === undefined) throw new Error(`不认识方块「${name}」，试试 minecraft 里的英文名，比如 oak_log / iron_ore`);
    const targets = bot.findBlocks({ matching: id, maxDistance: 32, count: Math.min(Math.max(Number(count) || 1, 1), 12) });
    if (!targets.length) throw new Error(`附近 32 格没找到 ${name}`);
    let mined = 0;
    for (const p of targets) {
      try {
        await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1));
        const block = bot.blockAt(p);
        if (!block || block.name !== name) continue;
        await this.#equipFor(block.name);
        await bot.dig(block);
        mined++;
        await this.#pickupNearby();
      } catch (err) {
        this.logger?.warn?.(`挖 ${name} 失败：${err.message}`);
      }
    }
    return { mined, remaining: targets.length - mined };
  }

  /** 换最合适的工具（镐/斧/锹），没有就不换。 */
  async #equipFor(blockName) {
    const bot = this.#require();
    const kind = /ore|stone|cobble|deepslate|obsidian|brick|concrete|sandstone|netherrack/.test(blockName)
      ? 'pickaxe'
      : /log|planks|wood|fence|door/.test(blockName)
        ? 'axe'
        : /dirt|sand|gravel|clay|snow|grass/.test(blockName)
          ? 'shovel'
          : '';
    if (!kind) return;
    const order = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
    const tools = (bot.inventory?.items?.() || [])
      .filter((it) => it.name.endsWith(kind))
      .sort((a, b) => order.indexOf(a.name.split('_')[0]) - order.indexOf(b.name.split('_')[0]));
    const best = tools[0];
    if (!best) return;
    if (bot.heldItem?.name === best.name) return;
    try {
      await bot.equip(best, 'hand');
      this.logger?.info?.(`换上 ${best.name}`);
    } catch {
      /* ignore */
    }
  }

  /** 捡附近掉落物（挖完顺手捡）。 */
  async #pickupNearby() {
    const bot = this.#require();
    for (let i = 0; i < 3; i++) {
      const drop = bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 10);
      if (!drop) return;
      try {
        await bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1));
        await new Promise((r) => setTimeout(r, 400));
      } catch {
        return;
      }
    }
  }

  /** 跟着某个玩家走。 */
  async follow(name, distance = 3) {
    const bot = this.#require();
    const target = bot.players?.[name]?.entity;
    if (!target) throw new Error(`没看到玩家「${name}」，等他进服或者检查名字`);
    bot.pathfinder.setGoal(new goals.GoalFollow(target, Math.max(1, Number(distance) || 3)), true);
    this.following = name;
    return { following: name, distance };
  }

  stopFollow() {
    const bot = this.#require();
    bot.pathfinder.setGoal(null);
    this.following = '';
    return { ok: true };
  }

  /** 饿了就吃。 */
  async eatIfHungry(threshold = 16) {
    const bot = this.#require();
    if ((bot.food ?? 20) >= threshold) return { ate: false, food: bot.food };
    const foods = /bread|apple|cooked|beef|porkchop|chicken|mutton|rabbit|cod|salmon|potato|carrot|melon|berries|cookie|cake|stew|soup/;
    const food = (bot.inventory?.items?.() || []).find((it) => foods.test(it.name));
    if (!food) return { ate: false, food: bot.food, reason: '背包里没吃的' };
    try {
      await bot.equip(food, 'hand');
      await bot.consume();
      return { ate: true, food: bot.food };
    } catch (err) {
      return { ate: false, food: bot.food, reason: err.message };
    }
  }

  /** 在指定坐标放一个方块。 */
  async placeAt(x, y, z, blockName) {
    const bot = this.#require();
    const item = (bot.inventory?.items?.() || []).find(
      (it) => it.name === blockName || it.name.endsWith(`_${blockName}`),
    );
    if (!item) throw new Error(`背包里没有「${blockName}」`);
    const ref = bot.blockAt(new Vec3(Number(x), Number(y) - 1, Number(z)));
    if (!ref || ref.name === 'air') throw new Error('目标位置下面没有方块，先垫一层');
    await bot.equip(item, 'hand');
    await bot.placeBlock(ref, new Vec3(0, 1, 0));
    return { placed: true, at: { x: Number(x), y: Number(y), z: Number(z) } };
  }

  /** 转头看某个玩家（说话时用）。 */
  async lookAtPlayer(name) {
    const bot = this.#require();
    const target = bot.players?.[name]?.entity;
    if (!target) return { ok: false };
    try {
      await bot.lookAt(target.position.offset(0, 1.6, 0), true);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /** 合成物品（缺中间材料就自动补木板/木棍）。 */
  async craft(name, count = 1, depth = 0) {
    const bot = this.#require();
    const wanted = this.#resolveItem(name);
    const id = bot.registry?.itemsByName?.[wanted]?.id;
    if (id === undefined) throw new Error(`不认识物品「${name}」`);
    const n = Math.min(Math.max(Number(count) || 1, 1), 16);
    const craftable = () => {
      const table = bot.findBlock({ matching: (b) => b.name.endsWith('crafting_table'), maxDistance: 16 });
      const withTable = table ? bot.recipesFor(id, null, 1, table) : [];
      return withTable.length ? { recipe: withTable[0], table } : { recipe: bot.recipesFor(id, null, 1, null)[0], table: null };
    };
    let { recipe, table } = craftable();
    if (!recipe) {
      // 背包里有工作台就先放一个，用完再说
      const tableItem = bot.inventory?.items?.().find((it) => it.name === 'crafting_table');
      if (tableItem) {
        const pos = bot.entity.position;
        try {
          await this.placeAt(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), 'crafting_table');
        } catch { /* 放不下就算了 */ }
        ({ recipe, table } = craftable());
      }
    }
    if (!recipe) {
      // 常见中间产物：原木→木板→木棍
      for (const dep of this.#depsFor(wanted)) {
        if (!dep || depth >= 3) continue;
        try {
          await this.craft(dep, 4, depth + 1);
        } catch {
          /* 补不上就算了，最后统一报错 */
        }
      }
      ({ recipe, table } = craftable());
    }
    if (!recipe) throw new Error(`材料不够或需要工作台（做 ${wanted}）`);
    if (table) await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
    const perCraft = recipe.result?.count || 1;
    const times = Math.max(1, Math.ceil(n / perCraft));
    await bot.craft(recipe, times, table || undefined);
    return { crafted: wanted, count: times * perCraft, times };
  }

  /** 常见物品的依赖链（只补一层，避免无限递归）。 */
  #depsFor(name) {
    const log = this.bot.inventory?.items?.().find((it) => it.name.endsWith('_log'));
    const planks = log ? log.name.replace('_log', '_planks') : 'oak_planks';
    if (name === 'stick') return [planks];
    if (name.endsWith('_pickaxe') || name.endsWith('_axe') || name.endsWith('_sword')) {
      return ['stick', planks];
    }
    if (name === 'crafting_table' || name === 'chest' || name === 'furnace') return [planks];
    if (name.endsWith('_planks')) return [log ? log.name : ''];
    return [];
  }

  #resolveItem(name) {
    const n = String(name || '').trim();
    if (n === 'planks' || n === 'wood_planks') {
      const has = this.bot.inventory?.items?.().find((it) => it.name.endsWith('_planks'));
      if (has) return has.name;
      const log = this.bot.inventory?.items?.().find((it) => it.name.endsWith('_log'));
      return log ? log.name.replace('_log', '_planks') : 'oak_planks';
    }
    if (n === 'log' || n === 'wood') {
      const log = this.bot.inventory?.items?.().find((it) => it.name.endsWith('_log'));
      return log ? log.name : 'oak_log';
    }
    return n;
  }

  /** 箱子：list / put / take。 */
  async chest(action = 'list', item = '', count = 1) {
    const bot = this.#require();
    const block = bot.findBlock({ matching: (b) => /chest|barrel/.test(b.name), maxDistance: 32 });
    if (!block) throw new Error('附近 32 格没有箱子');
    await bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2));
    const cont = await bot.openContainer(block);
    try {
      const listOf = (items) => items.map((i) => `${i.name}x${i.count}`);
      if (action === 'list') {
        return { chest: listOf(cont.containerItems()).slice(0, 30), bag: listOf(bot.inventory.items()).slice(0, 30) };
      }
      const want = this.#resolveItem(item);
      if (action === 'put') {
        const it = bot.inventory.items().find((x) => x.name === want);
        if (!it) throw new Error(`背包里没有 ${want}`);
        await cont.deposit(it.type, null, Math.min(Number(count) || it.count, it.count));
        return { put: want, count: Math.min(Number(count) || it.count, it.count) };
      }
      if (action === 'take') {
        const it = cont.containerItems().find((x) => x.name === want);
        if (!it) throw new Error(`箱子里没有 ${want}`);
        await cont.withdraw(it.type, null, Math.min(Number(count) || it.count, it.count));
        return { took: want, count: Math.min(Number(count) || it.count, it.count) };
      }
      throw new Error('action 只能是 list / put / take');
    } finally {
      try {
        cont.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** 打最近的怪（或指定名字）。 */
  async attack(name = '') {
    const bot = this.#require();
    const hostile = /zombie|skeleton|creeper|spider|enderman|witch|pillager|drowned|husk|stray|slime|phantom|blaze|ghast|magma|silverfish|vex|vindicator|evoker|ravager|wither_skeleton|guardian|shulker/;
    const target = bot.nearestEntity(
      (e) =>
        e.type === 'mob' &&
        (name ? e.name === name : hostile.test(e.name)) &&
        e.position.distanceTo(bot.entity.position) < 24,
    );
    if (!target) {
      const near = Object.values(bot.entities || {}).filter((e) => e && e.type === 'mob' && e.position.distanceTo(bot.entity.position) < 24).map((e) => e.name);
      throw new Error(`附近 24 格没找到要打的怪${near.length ? `（看到：${[...new Set(near)].join('/')}）` : ''}`);
    }
    // 换最好的剑/斧
    const order = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
    const weapon = bot.inventory
      .items()
      .filter((it) => it.name.endsWith('_sword') || it.name.endsWith('_axe'))
      .sort((a, b) => order.indexOf(a.name.split('_')[0]) - order.indexOf(b.name.split('_')[0]))[0];
    if (weapon) await bot.equip(weapon, 'hand').catch(() => {});
    const started = Date.now();
    let hits = 0;
    while (Date.now() - started < 20000) {
      if (!target.isValid || target.health <= 0) break;
      const dist = target.position.distanceTo(bot.entity.position);
      if (dist > 3) {
        try {
          await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2));
        } catch {
          break;
        }
      }
      try {
        await bot.lookAt(target.position.offset(0, 1.2, 0), true);
        bot.attack(target);
        hits++;
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    return { target: target.name, hits, killed: !target.isValid || target.health <= 0 };
  }

  // ---------- 生存规划：先做工具，再去挖 ----------

  #pickaxeTier() {
    const order = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
    const best = (this.bot.inventory?.items?.() || [])
      .filter((it) => it.name.endsWith('_pickaxe'))
      .sort((a, b) => order.indexOf(a.name.split('_')[0]) - order.indexOf(b.name.split('_')[0]))
      .pop();
    return best ? best.name.split('_')[0] : '';
  }

  #hasItem(name) {
    return this.#countItem(name) > 0;
  }

  #countLogs() {
    return (this.bot.inventory?.items?.() || [])
      .filter((it) => it.name.endsWith('_log'))
      .reduce((s, it) => s + it.count, 0);
  }

  /** 挖指定名字里的任意一种方块。 */
  async #digNames(names, count) {
    const bot = this.#require();
    const ids = names.map((n) => bot.registry?.blocksByName?.[n]?.id).filter((x) => x !== undefined);
    if (!ids.length) throw new Error(`不认识方块：${names.join('/')}`);
    const targets = bot.findBlocks({ matching: ids, maxDistance: 32, count: Math.min(Math.max(count, 1), 12) });
    let mined = 0;
    for (const p of targets) {
      try {
        await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1));
        const block = bot.blockAt(p);
        if (!block || !names.includes(block.name)) continue;
        await this.#equipFor(block.name);
        await bot.dig(block);
        mined++;
        await this.#pickupNearby();
      } catch (err) {
        this.logger?.warn?.(`挖 ${names[0]} 失败：${err.message}`);
      }
    }
    return mined;
  }

  async ensureWood(n = 4) {
    const have = this.#countLogs();
    if (have >= n) return { logs: have };
    const names = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
    const got = await this.#digNames(names, n - have);
    return { logs: this.#countLogs(), mined: got };
  }

  async ensurePlanks(n = 4) {
    const bot = this.#require();
    const planks = (bot.inventory?.items?.() || []).filter((it) => it.name.endsWith('_planks'));
    const have = planks.reduce((s, it) => s + it.count, 0);
    if (have >= n) return { planks: have };
    await this.ensureWood(Math.max(2, Math.ceil((n - have) / 4) + 1));
    const log = bot.inventory.items().find((it) => it.name.endsWith('_log'));
    if (!log) throw new Error('没木头，做不了木板');
    const plankName = log.name.replace('_log', '_planks');
    await this.craft(plankName, Math.max(4, n - have));
    return { planks: this.#countItem(plankName), name: plankName };
  }

  async ensureSticks(n = 2) {
    if (this.#countItem('stick') >= n) return { sticks: this.#countItem('stick') };
    await this.ensurePlanks(Math.max(2, Math.ceil(n / 2) * 2));
    await this.craft('stick', Math.max(4, Math.ceil(n / 4) * 4));
    return { sticks: this.#countItem('stick') };
  }

  /** 找一块真实存在的地面，把工作台放上去。 */
  async #placeTableNearby() {
    const bot = this.#require();
    try {
      await bot.waitForChunksToLoad?.();
    } catch {
      /* ignore */
    }
    const base = bot.entity.position;
    const bx = Math.floor(base.x);
    const by = Math.floor(base.y);
    const bz = Math.floor(base.z);
    for (let r = 1; r <= 4; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          for (let dy = -2; dy <= 3; dy++) {
            const x = bx + dx;
            const y = by + dy;
            const z = bz + dz;
            const ground = bot.blockAt(new Vec3(x, y, z));
            const above = bot.blockAt(new Vec3(x, y + 1, z));
            if (!ground || ground.name === 'air' || ground.name === 'water' || ground.name === 'lava') continue;
            if (!above || above.name !== 'air') continue;
            try {
              const item = bot.inventory.items().find((it) => it.name === 'crafting_table');
              if (!item) return false;
              await bot.equip(item, 'hand');
              await bot.placeBlock(ground, new Vec3(0, 1, 0));
              return true;
            } catch {
              /* 换下一格 */
            }
          }
        }
      }
    }
    return false;
  }

  async ensureTable() {
    const bot = this.#require();
    const near = bot.findBlock({ matching: (b) => b.name.endsWith('crafting_table'), maxDistance: 16 });
    if (near) return { table: 'nearby' };
    if (this.#hasItem('crafting_table')) {
      const ok = await this.#placeTableNearby();
      if (ok) return { table: 'placed' };
      return { table: 'carried' };
    }
    await this.ensurePlanks(4);
    await this.craft('crafting_table', 1);
    const ok = await this.#placeTableNearby();
    return { table: ok ? 'crafted' : 'carried' };
  }

  /** 保证至少有一把 tier 级别的镐，缺什么补什么。 */
  async ensurePickaxe(tier = 'wooden') {
    const order = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
    const have = this.#pickaxeTier();
    if (have && order.indexOf(have) >= order.indexOf(tier)) return { pickaxe: have };
    if (tier === 'wooden') {
      const nearTable = this.bot.findBlock({ matching: (b) => b.name.endsWith('crafting_table'), maxDistance: 16 });
      // 工作台 4 木板 + 木棍 2 木板 + 镐 3 木板
      await this.ensurePlanks(nearTable ? 5 : 9);
      await this.ensureTable();
      this.logger?.info?.(`[规划] 工作台后：${JSON.stringify(this.inventory().items)}`);
      await this.ensureSticks(2);
      this.logger?.info?.(`[规划] 木棍后：${JSON.stringify(this.inventory().items)}`);
      await this.craft('wooden_pickaxe', 1);
    } else if (tier === 'stone') {
      await this.ensurePickaxe('wooden');
      await this.#digNames(['stone'], 3);
      await this.ensureSticks(2);
      await this.craft('stone_pickaxe', 1);
    } else if (tier === 'iron') {
      throw new Error('铁镐要先有铁锭和熔炉，暂时做不了；先用石镐');
    } else {
      throw new Error(`做不了 ${tier} 镐`);
    }
    const now = this.#pickaxeTier();
    if (!now) throw new Error(`做 ${tier} 镐失败了（可能缺材料）`);
    return { pickaxe: now };
  }

  /** 带工具链的收集：去挖 iron/stone/wood/coal。 */
  async startGather(target, count, ownerName = '') {
    this.#require();
    if (this.task && ['running', 'returning'].includes(this.task.status)) {
      throw new Error(`已有任务在跑：${this.task.target || this.task.block} ${this.task.progress || 0}/${this.task.target}`);
    }
    const map = {
      iron: { block: 'iron_ore', item: 'raw_iron', pickaxe: 'stone', label: '铁' },
      stone: { block: 'stone', item: 'cobblestone', pickaxe: 'wooden', label: '石头' },
      wood: { block: 'oak_log', item: 'oak_log', pickaxe: '', label: '木头' },
      coal: { block: 'coal_ore', item: 'coal', pickaxe: 'wooden', label: '煤' },
    };
    const spec = map[String(target || '').toLowerCase()];
    if (!spec) throw new Error('只支持 iron / stone / wood / coal');
    const n = Math.min(Math.max(Number(count) || 1, 1), 32);
    this.task = {
      kind: 'gather',
      goal: String(target).toLowerCase(),
      block: spec.block,
      item: spec.item,
      targetCount: n,
      progress: 0,
      steps: [],
      status: 'running',
      owner: ownerName || this.cfg.ownerName || '',
      startedAt: Date.now(),
    };
    this.#runGather(spec, n).catch((err) => {
      if (this.task) {
        this.task.status = 'failed';
        this.task.error = err.message;
      }
      this.logger?.warn?.(`收集任务失败：${err.message}`);
    });
    return this.taskSummary();
  }

  async #runGather(spec, n) {
    const task = this.task;
    const step = (text) => {
      task.steps.push(text);
      task.detail = text;
      this.logger?.info?.(`[MC任务] ${text}`);
    };
    // 1) 工具链
    if (spec.pickaxe) {
      step(`先准备 ${spec.pickaxe} 镐`);
      await this.ensurePickaxe(spec.pickaxe);
      step(`有了 ${this.#pickaxeTier()} 镐`);
    }
    // 2) 工具校验：没到要求的镐就别挖，免得白挖
    if (spec.pickaxe) {
      const order = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
      const now = this.#pickaxeTier();
      if (!now || order.indexOf(now) < order.indexOf(spec.pickaxe)) {
        throw new Error(`工具没升级成功（现在是 ${now || '空手'}），需要 ${spec.pickaxe} 镐`);
      }
    }
    // 3) 开挖
    const before = this.#countItem(spec.item);
    let attempts = 0;
    while (task.status === 'running' && attempts < 6) {
      const gained = this.#countItem(spec.item) - before;
      task.progress = Math.max(0, gained);
      if (task.progress >= n) break;
      step(`挖 ${spec.label}：${task.progress}/${n}`);
      await this.#digNames([spec.block], Math.min(6, n - task.progress));
      attempts++;
    }
    task.progress = Math.max(0, this.#countItem(spec.item) - before);
    if (task.progress < n) {
      task.status = 'failed';
      task.error = `只挖到 ${task.progress}/${n}`;
      return;
    }
    // 3) 回去找主人
    task.status = 'returning';
    const owner = task.owner ? this.bot.players?.[task.owner]?.entity : null;
    if (owner) {
      try {
        await Promise.race([
          this.bot.pathfinder.goto(new goals.GoalNear(owner.position.x, owner.position.y, owner.position.z, 2)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('回去超时')), 30000)),
        ]);
        task.returned = true;
      } catch {
        task.returned = false;
      }
    }
    task.status = 'done';
    task.finishedAt = Date.now();
    step(`完成：${spec.label} ${task.progress}/${n}`);
    try {
      this.say(`搞定，${n} 个${spec.label}带回来了`);
    } catch {
      /* ignore */
    }
  }

  /** 开始一个“收集 N 个方块”的任务，挖够就回去找主人。 */
  async startCollect(block, count, ownerName = '') {
    const bot = this.#require();
    const map = { iron_ore: 'iron', deepslate_iron_ore: 'iron', stone: 'stone', coal_ore: 'coal' };
    if (map[String(block).toLowerCase()]) return this.startGather(map[String(block).toLowerCase()], count, ownerName);
    if (this.task && ['running', 'returning'].includes(this.task.status)) {
      throw new Error(`已有任务在跑：${this.task.block} ${this.task.progress || 0}/${this.task.target}`);
    }
    const target = Math.min(Math.max(Number(count) || 1, 1), 64);
    const item = this.#blockToItem(block);
    const before = this.#countItem(item);
    this.task = {
      kind: 'collect',
      block,
      item,
      target,
      before,
      progress: 0,
      status: 'running',
      owner: ownerName || this.cfg.ownerName || '',
      startedAt: Date.now(),
    };
    this.logger?.info?.(`接任务：收集 ${block} x${target}`);
    this.#runCollect().catch((err) => {
      if (this.task) {
        this.task.status = 'failed';
        this.task.error = err.message;
      }
      this.logger?.warn?.(`收集任务失败：${err.message}`);
    });
    return this.taskSummary();
  }

  taskSummary() {
    if (!this.task) return { active: false };
    return { ...this.task };
  }

  cancelTask() {
    if (!this.task) return { active: false };
    this.task.status = 'cancelled';
    this.bot?.pathfinder?.setGoal(null);
    return { cancelled: true };
  }

  #blockToItem(block) {
    const b = String(block || '').toLowerCase();
    if (b === 'stone') return 'cobblestone';
    if (b === 'iron_ore' || b === 'deepslate_iron_ore') return 'raw_iron';
    if (b === 'coal_ore') return 'coal';
    if (b === 'diamond_ore') return 'diamond';
    return b;
  }

  #countItem(name) {
    if (!this.online) return 0;
    return (this.bot.inventory?.items?.() || []).filter((it) => it.name === name).reduce((s, it) => s + it.count, 0);
  }

  async #runCollect() {
    const task = this.task;
    while (task.status === 'running') {
      const gained = this.#countItem(task.item) - task.before;
      task.progress = Math.max(0, gained);
      if (task.progress >= task.target) {
        task.status = 'returning';
        break;
      }
      const need = task.target - task.progress;
      try {
        await this.dig(task.block, Math.min(6, need));
      } catch (err) {
        task.status = 'failed';
        task.error = err.message;
        return;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (task.status !== 'returning') return;
    const ownerName = task.owner;
    const owner = ownerName ? this.bot.players?.[ownerName]?.entity : null;
    if (owner) {
      try {
        await Promise.race([
          this.bot.pathfinder.goto(new goals.GoalNear(owner.position.x, owner.position.y, owner.position.z, 2)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('回去超时')), 30000)),
        ]);
        task.returned = true;
        try {
          this.say(`挖够了，${task.target} 个${task.block}回来了`);
        } catch {
          /* ignore */
        }
      } catch {
        task.returned = false;
      }
    }
    task.progress = task.target;
    task.status = 'done';
    task.finishedAt = Date.now();
  }

  /** 用背包里的方块搭一个实心长方体（体积上限 64）。 */
  async buildBox({ x, y, z, width = 3, height = 3, depth = 3, block = 'cobblestone' }) {
    const bot = this.#require();
    const w = Math.min(Math.max(Number(width) || 3, 1), 8);
    const h = Math.min(Math.max(Number(height) || 3, 1), 6);
    const d = Math.min(Math.max(Number(depth) || 3, 1), 8);
    const volume = w * h * d;
    if (volume > 64) throw new Error(`体积 ${volume} 太大，最多 64 格`);
    const item = (bot.inventory?.items?.() || []).find((it) => it.name === block || it.name.endsWith(`_${block}`));
    if (!item) throw new Error(`背包里没有「${block}」`);
    const ox = Math.floor(Number(x));
    const oy = Math.floor(Number(y));
    const oz = Math.floor(Number(z));
    let placed = 0;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        for (let dz = 0; dz < d; dz++) {
          const px = ox + dx;
          const py = oy + dy;
          const pz = oz + dz;
          const cur = bot.blockAt(new Vec3(px, py, pz));
          if (!cur || cur.name !== 'air') continue;
          try {
            await this.#placeCell(px, py, pz);
            placed++;
          } catch {
            /* 放不下的跳过 */
          }
        }
      }
    }
    return { placed, requested: volume, block };
  }

  /** 从六个相邻面里找一个支撑面放方块。 */
  async #placeCell(x, y, z) {
    const bot = this.#require();
    const item = bot.heldItem;
    const offsets = [
      [0, -1, 0],
      [0, 1, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const [dx, dy, dz] of offsets) {
      const ref = bot.blockAt(new Vec3(x + dx, y + dy, z + dz));
      if (!ref || ref.name === 'air' || ref.name === 'water' || ref.name === 'lava') continue;
      try {
        await bot.placeBlock(ref, new Vec3(-dx, -dy, -dz));
        return true;
      } catch {
        /* 换下一个面 */
      }
    }
    throw new Error('没有可依附的面');
  }

  /** 收成熟的作物（小麦/胡萝卜/土豆/甜菜）。 */
  async harvest() {
    const bot = this.#require();
    const ids = ['wheat', 'carrots', 'potatoes', 'beetroots']
      .map((n) => bot.registry?.blocksByName?.[n]?.id)
      .filter((x) => x !== undefined);
    if (!ids.length) throw new Error('不认识作物');
    const blocks = bot.findBlocks({ matching: ids, maxDistance: 24, count: 16 });
    let harvested = 0;
    for (const p of blocks) {
      try {
        const b = bot.blockAt(p);
        if (!b) continue;
        const age = b.getProperties?.().age;
        const max = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 }[b.name] ?? 7;
        if (age === undefined || age < max) continue;
        await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1));
        await bot.dig(b);
        harvested++;
        await this.#pickupNearby();
      } catch {
        /* 跳过这一株 */
      }
    }
    return { harvested, found: blocks.length };
  }

  /** 睡觉（夜晚/雷雨才有效）。 */
  async sleep() {
    const bot = this.#require();
    const bed = bot.findBlock({ matching: (b) => b.name.endsWith('_bed'), maxDistance: 32 });
    if (!bed) throw new Error('附近没有床');
    await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
    await bot.sleep(bed);
    return { sleeping: true };
  }

  /** 出生在树上/半空时，先走到附近地面。 */
  async #settleOnGround() {
    const bot = this.#require();
    try {
      await bot.waitForChunksToLoad?.();
    } catch {
      /* ignore */
    }
    const base = bot.entity.position;
    const standing = bot.blockAt(new Vec3(Math.floor(base.x), Math.floor(base.y) - 1, Math.floor(base.z)));
    if (standing && standing.name !== 'air' && !/leaves|log/.test(standing.name)) return;
    let best = null;
    for (let r = 1; r <= 10 && !best; r++) {
      for (let dx = -r; dx <= r && !best; dx++) {
        for (let dz = -r; dz <= r && !best; dz++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const x = Math.floor(base.x) + dx;
          const z = Math.floor(base.z) + dz;
          for (let y = Math.floor(base.y) + 4; y >= Math.floor(base.y) - 24; y--) {
            const b = bot.blockAt(new Vec3(x, y, z));
            const a1 = bot.blockAt(new Vec3(x, y + 1, z));
            const a2 = bot.blockAt(new Vec3(x, y + 2, z));
            if (!b || b.name === 'air' || b.name === 'water' || b.name === 'lava') continue;
            if (/leaves|_log|log$/.test(b.name)) continue;
            if (!a1 || a1.name !== 'air' || !a2 || a2.name !== 'air') continue;
            best = { x, y: y + 1, z };
            break;
          }
        }
      }
    }
    if (!best) return;
    this.logger?.info?.(`从半空落到 ${best.x},${best.y},${best.z}`);
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(best.x, best.y, best.z, 0)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('落地超时')), 20000)),
    ]).catch((err) => {
      this.logger?.warn?.(`落地失败：${err.message}`);
    });
  }

  /** 给对话用的状态快照（背包、附近怪）。 */
  snapshot() {
    const bot = this.#require();
    const pos = bot.entity.position;
    const items = {};
    for (const it of bot.inventory?.items?.() || []) items[it.name] = (items[it.name] || 0) + it.count;
    const inv = Object.entries(items).map(([k, v]) => `${k}x${v}`);
    const hostile = /zombie|skeleton|creeper|spider|enderman|witch|pillager|drowned|husk|stray|slime|phantom|blaze|ghast|magma|silverfish|vex|vindicator|evoker|ravager|wither_skeleton|guardian|shulker/;
    const nearbyHostiles = (bot.entities ? Object.values(bot.entities) : []).filter(
      (e) => e && e.type === 'mob' && hostile.test(e.name || '') && e.position.distanceTo(pos) < 12,
    ).length;
    return {
      position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
      health: Math.round(bot.health ?? 0),
      food: Math.round(bot.food ?? 0),
      timeOfDay: bot.time?.timeOfDay ?? 0,
      heldItem: bot.heldItem?.name || '空手',
      inventory: inv,
      nearbyHostiles,
      players: Object.keys(bot.players || {}).filter((p) => p !== bot.username).slice(0, 6),
    };
  }

  say(text) {
    const bot = this.#require();
    const msg = String(text || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
    if (!msg) throw new Error('要说点什么');
    bot.chat(msg);
    return { ok: true };
  }

  inventory() {
    const bot = this.#require();
    const items = {};
    for (const it of bot.inventory?.items?.() || []) items[it.name] = (items[it.name] || 0) + it.count;
    return { held: bot.heldItem?.name || '空手', items };
  }

  async disconnect() {
    if (!this.bot) return { ok: true };
    try {
      this.bot.quit();
    } catch {
      /* ignore */
    }
    this.bot = null;
    return { ok: true };
  }
}
