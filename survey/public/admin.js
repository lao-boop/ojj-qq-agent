const el=id=>document.getElementById(id);
let token='',rows=[],items=[];
function text(parent,tag,value){const n=document.createElement(tag);n.textContent=value;parent.append(n);return n;}
async function refresh(){
  const res=await fetch('/api/admin/responses',{headers:{Authorization:'Bearer '+token}});
  if(!res.ok)throw Error(res.status===401?'管理口令不正确':'暂时无法读取数据');
  rows=await res.json();
  el('summary').textContent=rows.length+' 份答卷　·　平均总分 '+(rows.length?(rows.reduce((a,r)=>a+r.total,0)/rows.length).toFixed(1)+' / 100':'—');
  el('averages').replaceChildren();el('rows').replaceChildren();
  items.forEach(([name],i)=>{
    const avg=rows.length?rows.reduce((a,r)=>a+r.scores[i],0)/rows.length:0;
    const div=text(el('averages'),'div','');text(div,'span',name);const meter=document.createElement('meter');
    meter.min=0;meter.max=10;meter.value=avg;div.append(meter);text(div,'b',rows.length?avg.toFixed(1):'—');
  });
  for(const r of rows){const d=text(el('rows'),'details','');text(d,'summary',new Date(r.created).toLocaleString('zh-CN')+'　·　'+r.total+' 分');
    text(d,'p',items.map(([n],i)=>n+' '+r.scores[i]).join('　'));text(d,'p','接住我的瞬间：'+(r.good||'未填写'));text(d,'p','希望改进：'+(r.improve||'未填写'));}
  if(!rows.length)text(el('rows'),'p','还没有收到答卷。');
  el('login').hidden=true;el('results').hidden=false;el('status').textContent='';
}
async function load(){try{items=await (await fetch('/items.json')).json();await refresh();}catch(e){el('status').textContent=e.message;}}
el('auth').onsubmit=e=>{e.preventDefault();token=el('key').value.trim();el('key').value='';load();};
el('refresh').onclick=load;el('logout').onclick=()=>location.reload();
el('csv').onclick=()=>{
  const fields=[['提交时间',...items.map(i=>i[0]),'总分','接住我的瞬间','希望改进'],...rows.map(r=>[r.created,...r.scores,r.total,r.good,r.improve])];
  const escape=v=>{let s=String(v);if(/^\s*[=+@-]|^[\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const url=URL.createObjectURL(new Blob(['\uFEFF'+fields.map(row=>row.map(escape).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='小鲸鱼体验答卷.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
