const el=id=>document.getElementById(id);
const storage='whale-survey-v1';
const groups=[['接话与表达',0,3],['理解与共情',3,7],['个性与节奏',7,10],['聊聊你的感受',10,10]];
const id=()=>Array.from(crypto.getRandomValues(new Uint8Array(18)),v=>v.toString(16).padStart(2,'0')).join('');
let state={id:id(),scores:Array(10).fill(null),good:'',improve:'',page:0};
try {
  const d=JSON.parse(sessionStorage.getItem(storage));
  if(d && /^[a-f0-9-]{36}$/.test(d.id) && Number.isInteger(d.page) && groups[d.page] &&
    Array.isArray(d.scores) && d.scores.length===10 && d.scores.every(v=>v===null||Number.isInteger(v)&&v>=0&&v<=10) &&
    typeof d.good==='string' && typeof d.improve==='string') state=d;
} catch {}
const save=()=>{try{sessionStorage.setItem(storage,JSON.stringify(state));}catch{}};
let items;
function progress(){
  const count=state.scores.filter(v=>v!==null).length;
  el('done').textContent=count; el('total').textContent=state.scores.reduce((a,b)=>a+(b||0),0);
  el('bar').style.width=count*10+'%';save();
}
function render(){
  const [title,start,end]=groups[state.page];
  el('sectionTitle').textContent=title;
  el('step').textContent='第 '+(state.page+1)+' / 4 组';
  el('range').textContent=state.page===3?'选填':'每项 0–10 分';
  el('back').hidden=!state.page;el('next').textContent=state.page===3?'提交答卷 →':'下一组 →';
  el('message').textContent='';const box=el('questions');box.replaceChildren();
  for(let i=start;i<end;i++){
    const field=document.createElement('fieldset');
    field.innerHTML='<legend><small>'+String(i+1).padStart(2,'0')+'</small> '+items[i][0]+'</legend><p>'+items[i][1]+'</p><div class="scale"></div><div class="ends"><span>完全不符合</span><span>非常符合</span></div>';
    for(let n=0;n<=10;n++){
      const label=document.createElement('label'), input=document.createElement('input'), num=document.createElement('span');
      input.type='radio';input.name='q'+i;input.required=true;input.value=n;input.checked=state.scores[i]===n;
      input.onchange=()=>{state.scores[i]=n;progress();};num.textContent=n;label.append(input,num);field.querySelector('.scale').append(label);
    }
    box.append(field);
  }
  if(state.page===3)for(const [key,prompt] of [['good','哪句话让你觉得小鲸鱼接住了你？'],['improve','哪一句让你觉得生硬？你希望它怎么接？']]){
    const label=document.createElement('label');label.className='feedback';label.textContent=prompt;
    const input=document.createElement('textarea');input.maxLength=1000;input.placeholder='可以只描述大意（选填）';input.value=state[key];
    input.oninput=()=>{state[key]=input.value;save();};label.append(input);box.append(label);
  }
  progress();
}
function scrollForm(){el('layout').scrollIntoView({block:'start'});}
el('back').onclick=()=>{state.page--;render();scrollForm();};
el('form').onsubmit=async e=>{
  e.preventDefault();
  if(state.page<3){state.page++;render();scrollForm();return;}
  const missing=state.scores.indexOf(null);
  if(missing!==-1){state.page=groups.findIndex(([,a,b])=>a<=missing&&missing<b);render();return;}
  el('next').disabled=el('back').disabled=true;
  try{
    const req=await fetch('/api/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)});
    const body=await req.json();if(!req.ok)throw Error(body.error);
    el('layout').hidden=true;el('success').hidden=false;el('receipt').textContent='本次体验总分为 '+body.total+' / 100。你可以关闭此页面。';
    el('success').scrollIntoView();try{sessionStorage.removeItem(storage);}catch{}
  }catch(err){el('message').textContent=err.message+'。请再次提交。';}
  finally{el('next').disabled=el('back').disabled=false;}
};
try {const res=await fetch('/items.json');if(!res.ok)throw Error();items=await res.json();render();}
catch {el('next').disabled=true;el('message').textContent='题目加载失败，请刷新页面。';}
