import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { isOwner } from './global.js';

const MEMBER_STATES = new Set(['working', 'blocked', 'submitted']);
const uuid = () => randomUUID();
const clean = (v, n = 3000) => String(v || '').trim().slice(0, n);

/** Persistent project workflow; model output never supplies paths or sender identity. */
export class ProjectSecretary {
  constructor({ cfg, dir = path.join(DATA_DIR, 'secretary'), send, download, logger, clock = () => Date.now() }) {
    Object.assign(this, { cfg, dir, send, download, logger, clock });
    this.file = path.join(dir, 'projects.json');
    this.busy = false;
    try { this.db = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw err; this.db = { projects: [], assets: [], outbox: [] }; }
    if (!['projects','assets','outbox'].every(k => Array.isArray(this.db[k]))) throw new Error('项目记录格式损坏');
    for (const delivery of this.db.outbox) if (delivery.status === 'sending') delivery.status = 'unknown';
  }
  enabled() { return Boolean(this.cfg.secretary?.enabled); }
  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.db, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  actor(chatKey) {
    const id = /^private:(\d{5,12})$/.exec(chatKey || '')?.[1];
    if (!this.enabled()) throw new Error('项目秘书尚未启用');
    if (!id) throw new Error('项目操作仅支持私聊');
    if (!isOwner(id, this.cfg) && !this.members().some(m => m.qq === id)) throw new Error('未登记为项目成员');
    return id;
  }
  members() { return (this.cfg.secretary?.members || []).map(m => ({ qq: String(m.qq), name: clean(m.name, 40) })); }
  resolveMembers(value) {
    const queries = clean(value, 1000).split(/[,，、]/).map(x => x.trim()).filter(Boolean);
    if (!queries.length || queries.length > 10) throw new Error('请指定1至10名已登记负责人');
    return [...new Set(queries.map(q => {
      const hits = this.members().filter(m => m.qq === q || m.name === q);
      if (hits.length !== 1 || !/^\d{5,12}$/.test(hits[0].qq)) throw new Error(`负责人“${q}”未登记或重名，请提供准确QQ号`);
      return hits[0].qq;
    }))];
  }
  requireOwner(actor) { if (!isOwner(actor, this.cfg)) throw new Error('只有老板或管理员可以交办、验收或催办'); }
  project(id, actor) {
    const p = this.db.projects.find(p => p.id === id);
    if (!p || (p.owner !== actor && !p.members.some(m => m.qq === actor))) throw new Error('项目不存在或无权访问');
    return p;
  }
  async capture(actor, items) {
    if (!items.length) return [];
    if (items.length > 8) throw new Error('一次最多交接8个附件，请分批提交');
    const stored = [];
    for (const item of items) {
      const downloaded = await this.download(item);
      const stat = fs.statSync(downloaded.path);
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('单个附件须为不超过20MB的文件');
      const bytes = fs.readFileSync(downloaded.path);
      const id = uuid();
      const name = path.basename(downloaded.name || item.name || 'attachment').replace(/[\\/:*?"<>|]/g, '_');
      const file = path.join(this.dir, 'assets', id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      this.db.assets.push({ id, actor, name, kind: item.kind || 'file', file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), at: this.clock() });
      stored.push(id);
    }
    this.save();
    return stored;
  }
  assets(ids, actor) {
    if (!Array.isArray(ids) || ids.length > 8) throw new Error('附件清单无效');
    return ids.map(id => {
      const a = this.db.assets.find(a => a.id === id && a.actor === actor);
      if (!a) throw new Error('附件不存在或不属于当前发送者');
      return a;
    });
  }
  enqueue(p, to, text, ids = []) {
    const base = { projectId: p.id, to, at: this.clock(), status: 'pending' };
    this.db.outbox.push({ ...base, id: uuid(), text });
    for (const assetId of ids) this.db.outbox.push({ ...base, id: uuid(), assetId });
  }
  async flush() {
    if (this.busy || !this.enabled()) return;
    this.busy = true;
    try {
      for (const job of this.db.outbox.filter(j => j.status === 'pending')) {
        const p = this.db.projects.find(p => p.id === job.projectId);
        if (!p || ![p.owner, ...p.members.map(m => m.qq)].includes(job.to)) { job.status = 'failed'; job.error = '接收人不属于项目'; this.save(); continue; }
        if (!isOwner(job.to, this.cfg) && !this.members().some(m => m.qq === job.to)) { job.status = 'failed'; job.error = '接收人已移出成员名单'; this.save(); continue; }
        job.status = 'sending'; this.save();
        try {
          const asset = job.assetId ? this.db.assets.find(a => a.id === job.assetId) : undefined;
          if (job.assetId && !asset) throw new Error('附件缺失');
          await this.send({ to: job.to, text: job.text, asset });
          job.status = 'sent'; job.sentAt = this.clock();
        } catch (err) {
          job.status = /retcode=|未连接|附件缺失|ENOENT/.test(err.message || '') ? 'failed' : 'unknown';
          job.error = job.status === 'unknown' ? '发送结果未知，请核对后再操作' : '发送失败';
        }
        this.save();
      }
    } finally { this.busy = false; }
  }
  summary(p, actor) {
    const members = p.owner === actor ? p.members : p.members.filter(m => m.qq === actor);
    const deliveries = this.db.outbox.filter(j => j.projectId === p.id && (actor === p.owner || j.to === actor));
    return { id: p.id, title: p.title, description: p.description, deadline: p.deadline, status: p.status,
      members: members.map(m => ({ qq: m.qq, state: m.state, latest: m.updates.at(-1) || null })),
      attachments: p.assets.map(id => this.db.assets.find(a => a.id === id)).filter(Boolean).map(a => ({name:a.name,kind:a.kind})),
      deliveries: { sent:deliveries.filter(j=>j.status==='sent').length, pending:deliveries.filter(j=>['pending','sending'].includes(j.status)).length, failed:deliveries.filter(j=>j.status==='failed').length, unknown:deliveries.filter(j=>j.status==='unknown').length } };
  }
  async execute(op, args, ctx) {
    const actor = this.actor(ctx.chatKey);
    if (op === 'project_status') {
      const projects = args.projectId ? [this.project(args.projectId, actor)] : this.db.projects.filter(p => p.owner === actor || p.members.some(m => m.qq === actor));
      return projects.map(p => this.summary(p, actor));
    }
    if (op === 'project_create') {
      this.requireOwner(actor);
      const assignees = this.resolveMembers(args.assignees);
      if (!clean(args.title) || !clean(args.description)) throw new Error('项目名称和交付要求不能为空');
      const deadline = args.deadline ? Date.parse(args.deadline) : null;
      if (args.deadline && (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(args.deadline) || !Number.isFinite(deadline) || deadline <= this.clock())) throw new Error('截止时间须为带时区的未来ISO时间');
      if (this.db.projects.filter(p=>p.status==='active').length >= 100) throw new Error('活动项目已达100个，请先完成验收');
      const ids = ctx.projectAttachments || []; this.assets(ids, actor);
      const p = { id:uuid().slice(0,8), owner:actor, title:clean(args.title,100), description:clean(args.description), deadline, status:'active', createdAt:this.clock(), assets:[...ids],
        members:assignees.map(qq=>({qq,state:'assigned',updates:[],lastReminderAt:this.clock(),reminderDay:'',reminderCount:0})) };
      this.db.projects.push(p);
      for (const qq of assignees) this.enqueue(p,qq,`【项目 ${p.id}】${p.title}\n要求：${p.description}\n截止：${deadline ? new Date(deadline).toISOString() : '未设置'}\n回复 /项目 进度 ${p.id} | 进展，或 /项目 提交 ${p.id} | 交付说明，可附图片、文件、语音、视频。`,ids);
      this.save(); await this.flush(); return this.summary(p,actor);
    }
    const p = this.project(args.projectId, actor);
    if (op === 'project_update') {
      const member = p.members.find(m=>m.qq===actor);
      if (!member || p.status !== 'active' || member.state === 'accepted') throw new Error('只有尚未验收的负责人可反馈此项目');
      if (!MEMBER_STATES.has(args.state)) throw new Error('反馈状态须为working、blocked或submitted');
      const ids = ctx.projectAttachments || []; this.assets(ids,actor);
      if (!clean(args.text) && !ids.length) throw new Error('请提供进展说明或交付附件');
      const update = { id:uuid(), at:this.clock(), text:clean(args.text), assets:[...ids], state:args.state };
      member.updates.push(update); member.state=args.state; member.lastReminderAt=this.clock();
      this.enqueue(p,p.owner,`【项目 ${p.id} · ${p.title}】负责人 ${actor}\n状态：${args.state}\n${update.text || '附件交付'}\n${args.state==='submitted' ? '已提交，等待老板验收；不代表完成。' : ''}`,ids);
    } else if (op === 'project_review') {
      if (actor !== p.owner) throw new Error('只有交办此项目的老板可以验收');
      const member=p.members.find(m=>m.qq===String(args.member));
      if (!member || p.status!=='active' || member.state!=='submitted' || !['accept','rework'].includes(args.decision)) throw new Error('请对已提交的负责人选择accept或rework');
      if (args.decision==='rework' && !clean(args.text)) throw new Error('退回时请说明修改要求');
      member.state=args.decision==='accept'?'accepted':'working';
      member.reviews ??= []; member.reviews.push({at:this.clock(),decision:args.decision,text:clean(args.text)});
      this.enqueue(p,member.qq,`【项目 ${p.id} 验收】${args.decision==='accept'?'通过':'需修改'}\n${clean(args.text)}`);
      if (p.members.every(m=>m.state==='accepted')) {p.status='completed';p.completedAt=this.clock();this.enqueue(p,p.owner,`【项目 ${p.id}】所有负责人均已验收通过，项目完成。`);}
    } else if (op === 'project_remind') {
      if (actor!==p.owner) throw new Error('只有项目老板可催办');
      this.remind(p,false);
    } else if (op === 'project_files') {
      const ids = actor === p.owner ? [...p.assets,...p.members.flatMap(m=>m.updates.flatMap(u=>u.assets))] : [...p.assets,...p.members.find(m=>m.qq===actor).updates.flatMap(u=>u.assets)];
      if (!ids.length) return {message:'此项目还没有附件'};
      this.enqueue(p,actor,`【项目 ${p.id}】交接材料（原文件，未自动转换）`,[...new Set(ids)]);
    } else throw new Error('未知项目操作');
    this.save(); await this.flush(); return this.summary(p,actor);
  }
  remind(p, automatic) {
    if (p.status!=='active') throw new Error('项目已结束');
    const now=this.clock(), day=new Date(now).toISOString().slice(0,10);
    const interval=Math.max(60,Number(this.cfg.secretary?.reminderMinutes)||1440)*60000;
    for(const m of p.members) {
      if (['submitted','accepted'].includes(m.state)) continue;
      if (m.reminderDay!==day) {m.reminderDay=day;m.reminderCount=0;}
      if (m.reminderCount>=2 || now-m.lastReminderAt < (automatic?interval:60000)) continue;
      m.lastReminderAt=now;m.reminderCount++;
      this.enqueue(p,m.qq,`【项目 ${p.id} 跟进】${p.title}\n${p.deadline && now>p.deadline?'已超过截止时间，请说明阻塞和预计完成时间。':'请反馈当前进展或提交交付材料。'}`);
      this.enqueue(p,p.owner,`【项目 ${p.id} 跟进】已安排提醒 ${m.qq} 反馈进展${p.deadline && now>p.deadline?'（已逾期）':''}，送达状态见项目查询。`);
    }
  }
  async tick() {
    if (!this.enabled() || this.busy) return;
    if (this.cfg.secretary?.autoRemind) for(const p of this.db.projects.filter(p=>p.status==='active')) this.remind(p,true);
    this.save(); await this.flush();
  }
}

export function parseProjectCommand(text) {
  const m=/^\/项目(?:\s+(\S+))?(?:\s+([^|]*))?(.*)$/s.exec(String(text).trim());
  if (!m) return null;
  const action=m[1]||'帮助', head=clean(m[2]), rest=(m[3]||'').split('|').slice(1).map(x=>x.trim());
  if(action==='新建') return {op:'project_create',args:{assignees:head,title:rest[0],description:rest[1],deadline:rest[2]}};
  if(action==='查看') return {op:'project_status',args:{projectId:head}};
  if(['进度','阻塞','提交'].includes(action)) return {op:'project_update',args:{projectId:head,state:{进度:'working',阻塞:'blocked',提交:'submitted'}[action],text:rest.join(' | ')}};
  if(['验收','退回'].includes(action)) {const [projectId,member]=head.split(/\s+/);return {op:'project_review',args:{projectId,member,decision:action==='验收'?'accept':'rework',text:rest.join(' | ')}};}
  if(action==='催办') return {op:'project_remind',args:{projectId:head}};
  if(action==='材料') return {op:'project_files',args:{projectId:head}};
  return {help:'项目秘书：\n/项目 新建 负责人QQ,负责人QQ | 项目名称 | 交付要求 | 截止时间(可选，如2026-11-01T18:00:00+08:00)\n/项目 查看 [编号]\n/项目 进度 编号 | 说明\n/项目 阻塞 编号 | 问题\n/项目 提交 编号 | 说明（可附文件）\n/项目 验收 编号 负责人QQ\n/项目 退回 编号 负责人QQ | 修改要求\n/项目 催办 编号\n/项目 材料 编号'};
}
