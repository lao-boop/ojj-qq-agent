import { TASK_STATUS } from './task-state.js';
import { OFFICE_STATUS } from './office-delivery.js';

const usage='用 /tasks 查看任务；/task 编号 查进度；/cancel 编号 取消未开始的任务；/resume 编号 继续中断文件任务；/retry 编号 重发明确上传失败的文件。';
export class TaskControl {
  constructor({state,delivery,logger}) {Object.assign(this,{state,delivery,logger});}
  visible(key,actor) {
    return this.state.visible(key,actor).filter(t=>!t.operations.every(op=>op.startsWith('memory.')));
  }
  describe(task) {
    const docs=Object.values(task.deliveries || {});
    const detail=docs.length?docs.map(r=>`${r.name}：${OFFICE_STATUS[r.status] || r.status}`).join('\n'):TASK_STATUS[task.status];
    return `${task.id.slice(0,8)} · ${String(task.slots?.topic || task.goal || '任务').slice(0,100)}\n${detail}${task.backgroundState?`\n其他后台步骤：${TASK_STATUS[task.backgroundState] || task.backgroundState}`:''}`;
  }
  resolve(key,actor,id) {
    const matches=this.visible(key,actor).filter(t=>t.id===id || (id.length>=8 && t.id.startsWith(id)));
    return matches.length===1?matches[0]:null;
  }
  cancel(task,key,actor) {
    if(!this.visible(key,actor).includes(task))return '没有找到属于你的这项任务。';
    const docs=Object.values(task.deliveries || {});
    if(docs.length)return docs.map(r=>`${r.name}：${this.delivery.cancel(r.id,key,actor).reply}`).join('\n');
    if(task.status==='draft') {this.state.finish(task,'cancelled');return '已取消这项待处理草稿。';}
    return `当前状态为${TASK_STATUS[task.status]}，不能可靠取消或撤回。`;
  }
  handle(chat,actor,text) {
    const input=String(text).trim();
    if(/^(?:\/tasks|\/任务|查看我的任务|列出我的任务|我的任务)[。！？!?]?$/i.test(input)) {
      const all=this.visible(chat.key,actor), tasks=[...all].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,12);
      return tasks.length?`${tasks.map(t=>this.describe(t)).join('\n\n')}\n${all.length>12?`共${all.length}项，此处显示最近12项。\n`:''}${usage}`:'你目前没有任务记录。';
    }
    const match=/^(?:\/(tasks|task|任务|进度|cancel|取消|resume|继续|retry|重发)|(?:查看任务|取消任务|继续任务|重发任务))\s*([a-f0-9-]{8,36})?\s*[。！!]?$/i.exec(input);
    if(!match)return /^\/(tasks|task|任务|进度|cancel|取消|resume|继续|retry|重发)(?:\s|$)/i.test(input)?usage:null;
    const id=match[2];if(!id)return usage;
    const task=this.resolve(chat.key,actor,id);
    if(!task)return '没有找到属于你的这项任务，请用 /tasks 查看编号。';
    const command=(match[1]||input.split('任务')[0]).toLowerCase();
    if(['task','tasks','任务','进度','查看'].includes(command))return this.describe(task);
    if(['cancel','取消'].includes(command))return this.cancel(task,chat.key,actor);
    const docs=Object.values(task.deliveries || {});
    if(!docs.length)return task.status==='draft'?'这是尚未执行的草稿。请说明要开始制作及缺少的材料，执行前仍会核对要求。':'这项任务没有可恢复的文件步骤；不会自动重做其他操作。';
    return docs.map(r=>{
      const result=this.delivery.resume(r.id,chat.key,actor,{retryOnly:['retry','重发'].includes(command)});
      result.completion?.catch(error=>this.logger?.warn?.(`继续任务失败：${error.message}`));
      return `${r.name}：${result.reply}`;
    }).join('\n');
  }
}
