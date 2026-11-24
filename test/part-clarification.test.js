import test from 'node:test';
import assert from 'node:assert/strict';
import {Brain} from '../src/brain.js';
import {choosePartQuestion, explainedRearLamp, galleryChoice} from '../src/part-clarification.js';

const photo = {base64:'data:image/jpeg;base64,YQ=='};
const extra = {base64:'data:image/jpeg;base64,Yg=='};
const decision = (kind,label,caption)=>JSON.stringify({kind,label,caption});
function fixture(responses, reference={labels:[]}) {
  const calls=[];
  const brain=new Brain({cfg:{},logger:{debug(){},warn(){},info(){}},tools:{specs:[]},
    memory:{context:()=>({notes:[],turns:[]}),append(){},maybeSummarize:async()=>{}},
    lookupParts:async()=>reference,llm:{chat:async req=>{
      calls.push(req);
      assert.ok(responses.length,'unexpected model call');
      return {content:responses.shift()};
    }}});
  brain.buildSystem=()=>'测试';
  const send=(text,images=[],senderId='1')=>brain.respond({chatKey:'group:test',meta:{scene:'群聊',senderId},
    userText:text,images,replyOnly:true}).then(r=>r.bubbles.join(''));
  return {brain,send,calls};
}

const expertResult = JSON.stringify({kind:'part',label:'BRAKE PAD WEAR SENSOR',caption:'刹车片磨损报警线。',
  observation:'细线的卡头嵌在摩擦片边缘。',distinction:'末端是绝缘卡头，没有旋入排气管的金属螺纹。',
  originalFeature:'细线与塑料卡头',targetLink:'same_target'});

test('configured expert sees original pixels on conflict and can identify a small part outside the gallery',async()=>{
  const {brain,send,calls}=fixture([decision('part','OXYGEN SENSOR','氧传感器。'),expertResult],{labels:['BRAKE PAD'],strong:true,sheet:'Yw=='});
  brain.updateConfig({llm:{visionFallbackModel:'test-pro'}});
  assert.match(await send('这是什么',[photo]),/磨损报警线/);
  assert.equal(calls.length,2);
  assert.equal(calls[1].model,'test-pro');
  assert.deepEqual(calls[1].messages[1].content.filter(c=>c.type==='image_url').map(c=>c.image_url.url),[photo.base64]);
  assert.equal(brain.hasPendingPart('group:test','1'),false);
});

test('unsubstantiated expert and malformed follow-up preserve evidence; next expert sees both images and the question',async()=>{
  const unsupported=JSON.stringify({kind:'part',label:'TAILLIGHTS',caption:'尾灯。',observation:'一个红色的小灯泡。',distinction:'壳体上确实能看到灯泡。'});
  const {brain,send,calls}=fixture([decision('unclear','','有插头。'),unsupported,'invalid',expertResult]);
  brain.updateConfig({llm:{visionFallbackModel:'test-pro'}});
  const question=await send('这是什么',[photo]);
  assert.ok(brain.hasPendingPart('group:test','1'));
  assert.match(await send('我指的是那根细线',[extra]),/磨损报警线/);
  const content=calls.at(-1).messages[1].content;
  assert.deepEqual(content.filter(c=>c.image_url).map(c=>c.image_url.url),[photo.base64,extra.base64]);
  assert.ok(content.at(-1).text.includes(question));
  assert.match(content.at(-1).text,/我指的是那根细线/);
});

test('an unavailable expert leaves clarification usable and stops after two unanswered questions',async()=>{
  const {brain,send,calls}=fixture([]);
  brain.updateConfig({llm:{visionFallbackModel:'test-pro'}});
  brain.llm.chat=async req=>{
    calls.push(req);
    if(req.model==='test-pro')throw Error('timeout');
    return {content:decision('unclear','','灯座位置不清楚。')};
  };
  assert.match(await send('这是什么',[photo]),/车身位置/);
  assert.match(await send('不知道位置'),/亮/);
  assert.match(await send('也没试过'),/无法可靠确定/);
  assert.equal(brain.hasPendingPart('group:test','1'),false);
  assert.equal(calls.filter(c=>c.model==='test-pro').length,3);
});

test('clear primary answers skip the expert and matching model IDs never repeat the same call',async()=>{
  const {brain,send,calls}=fixture([decision('part','ALTERNATOR','发电机。'),decision('unclear','','只有插头。')]);
  brain.updateConfig({llm:{visionFallbackModel:'test-pro'}});
  assert.match(await send('这是什么',[photo]),/发电机/);
  brain.updateConfig({llm:{visionFallbackModel:brain.visionModel}});
  await send('这是什么',[extra]);
  assert.equal(calls.length,2);
});

test('natural high-center descriptions resolve the lamp while low fog lamps and possible locations remain open',()=>{
  assert.match(explainedRearLamp('车尾中间偏高的那一个，踩制动踏板它才亮。'),/高位制动灯/);
  assert.equal(explainedRearLamp('好像在车尾中间偏高，踩刹车亮。'),'');
  assert.equal(explainedRearLamp('在车尾保险杠中间，踩刹车亮。'),'');
  const question=choosePartQuestion(['这个插头接的是刹车卡钳还是排气管？','这个灯是装在车尾两侧还是后窗中央？'],
    {evidence:'lamp',previous:['这个灯在车尾哪个位置？'],notes:'没注意'});
  assert.match(question,/哪种操作/);
});

test('a wider photo of the mount cannot replace the first object even when both readers recognize the mount',async()=>{
  const mount=JSON.stringify({kind:'part',label:'BRAKE CALIPER',caption:'制动卡钳。',observation:'补图里有制动钳体和油管。',
    distinction:'可见制动油管与钳体相连。',targetLink:'mount_only',originalFeature:'首图只握着一根细线。'});
  const {brain,send}=fixture([decision('unclear','','有一根线。'),'invalid',mount,mount,
    decision('part','BRAKE PAD WEAR SENSOR','刹车片磨损报警线。')]);
  brain.updateConfig({llm:{visionFallbackModel:'test-pro'}});
  await send('这是什么',[photo]);
  await send('这是它装在车上的位置',[extra]);
  assert.ok(brain.hasPendingPart('group:test','1'));
  assert.match(await send('卡在摩擦片边上，接细线'),/报警线/);
});

test('independent disagreement asks directly and a text-only follow-up sees the original photo',async()=>{
  const {brain,send,calls}=fixture([
    decision('part','BRAKE PAD','刹车片。'),decision('part','BRAKE ROTOR','根据你补充的安装位置和形状，这是制动盘。')
  ],{labels:['BRAKE ROTOR'],strong:true,sheet:'Yw=='});
  assert.match(await send('这是什么？',[photo]),/也可以描述/);
  const sent=calls[0].messages.at(-1).content.filter(x=>x.type==='image_url');
  assert.equal(sent.length,1);
  assert.ok(brain.hasPendingPart('group:test','1'));
  assert.equal(brain.hasPendingPart('group:test','2'),false);
  assert.match(await send('是套在轮毂上的大圆盘'),/制动盘/);
  assert.equal(calls[1].messages.at(-1).content[1].image_url.url,photo.base64);
  assert.match(calls[1].messages.at(-1).content[0].text,/套在轮毂/);
  assert.equal(brain.hasPendingPart('group:test','1'),false);
});

test('inconclusive follow-ups keep the original image, description and new photo together',async()=>{
  const {send,calls}=fixture([decision('unclear','','只看到灯座。'),decision('unclear','','位置未明。'),
    JSON.stringify({kind:'part',label:'HIGH MOUNT STOP LAMP',landmark:'rear_window_center',targetLink:'same_target',originalFeature:'首图上的红色灯座',caption:'根据补图，这是高位制动灯。'})]);
  assert.match(await send('',[photo]),/安装位置|车身位置/);
  await send('拆下来时连着两根线');
  assert.match(await send('补图里它在后窗中央',[extra]),/高位制动灯/);
  const content=calls[2].messages.at(-1).content;
  assert.deepEqual(content.slice(1).map(x=>x.image_url.url),[photo.base64,extra.base64]);
  assert.match(content[0].text,/连着两根线/);
});

test('unreadable image accepts later text and an unrelated new request takes the usual chat path',async()=>{
  const {brain,send}=fixture([decision('unrelated','','换了话题。'),'明天的安排如下。']);
  assert.match(await send('',[{}]),/对焦再拍/);
  assert.match(await send('明天的安排是什么'),/安排如下/);
  assert.equal(brain.hasPendingPart('group:test','1'),false);
});

test('a weak neighbour alone does not veto a supported visual answer',async()=>{
  const {brain}=fixture([decision('part','ALTERNATOR','发电机。')],{labels:['WATER PUMP'],strong:false});
  assert.match(await brain.describeImages([photo]),/发电机/);
});

test('a contradictory supplemental lamp label keeps the case pending',async()=>{
  const {brain,send}=fixture([decision('unclear','','灯座，安装位置不明。'),
    decision('part','TAILLIGHTS','这是高位制动灯或普通尾灯。'),
    JSON.stringify({kind:'part',label:'HIGH MOUNT STOP LAMP',landmark:'rear_window_center',caption:'根据安装位置和亮灯时机，是高位制动灯。'})]);
  await send('',[photo]);
  await send('它在后挡风玻璃上沿');
  assert.ok(brain.hasPendingPart('group:test','1'));
  assert.match(await send('位于正中央，踩刹车亮'),/高位制动灯/);
  assert.equal(brain.hasPendingPart('group:test','1'),false);
});

test('brake verification can select the rotor itself',async()=>{
  const {brain,calls}=fixture([decision('part','BRAKE PAD','刹车片。'),
    JSON.stringify({label:'BRAKE ROTOR',cue:'hub_and_swept_disc',observation:'两手扶着带轮毂孔的盘面。',caption:'制动盘，两手扶着圆形盘面。'})]);
  assert.match(await brain.describeImages([photo]),/制动盘/);
  assert.match(calls[1].messages[0].content.at(-1).text,/BRAKE ROTOR/);
});

test('verified part name reaches user while an extra task still reaches chat',async()=>{
  const answer=JSON.stringify({kind:'part',label:'CABIN FILTER',filterMount:'hvac_intake',caption:'取下的是乘员舱进风口里带方向标记的滤芯。'});
  const verified=JSON.stringify({label:'CABIN FILTER',cue:'element_at_hvac_inlet',filterMount:'hvac_intake',observation:'滤框在手套箱后方进风口。',caption:'取下的是乘员舱进风口里带方向标记的滤芯。'});
  const {send,calls}=fixture([answer,verified,answer,verified,'拆装时先看手套箱后的卡扣。']);
  assert.match(await send('请识别照片中这一步正在检查、展示或拆装的汽车配件。',[photo]),/^空调滤芯/);
  assert.equal(calls.length,2);
  assert.match(await send('这是什么，怎么换？',[photo]),/卡扣/);
  assert.equal(calls.length,5);
});

test('a nearby box or a failed review cannot establish a fuse box',async()=>{
  for(const review of ['broken',JSON.stringify({label:'FUSE BOX',cue:'plastic_clip',observation:'黑色卡扣',caption:'保险丝盒。'})]){
    const {send,brain}=fixture([decision('part','FUSE BOX','保险丝盒。'),review]);
    assert.match(await send('这是什么',[photo]),/粗电缆/);
    assert.ok(brain.hasPendingPart('group:test','1'));
  }
});

test('a same-part follow-up retains the original target without passing a guessed name',async()=>{
  const {send,brain,calls}=fixture([decision('unclear','','可能是火花塞。'),
    decision('unrelated','','另一个部件。'),decision('part','BRAKE CALIPER','卡钳支架里的导销。')]);
  await send('这是什么',[photo]);
  await send('这是同一部件的另一张照片',[extra]);
  assert.ok(brain.hasPendingPart('group:test','1'));
  assert.doesNotMatch(calls[1].messages.at(-1).content[0].text,/火花塞/);
  assert.match(await send('从车轮里面跨盘的铸件抽出的'),/导销/);
});

test('rear lens colors cannot establish a corner mounting position',async()=>{
  const {brain,send}=fixture([decision('part','TAILLIGHTS','尾灯。'),
    JSON.stringify({label:'TAILLIGHTS',cue:'side_combination_housing',observation:'有红白分区',landmark:'unlocated',caption:'侧尾灯。'})]);
  assert.match(await send('这是什么',[photo]),/车尾两侧/);
  assert.ok(brain.hasPendingPart('group:test','1'));
});

test('a shared fog and headlight bulb cannot establish a headlight assembly',async()=>{
  const {send,brain}=fixture([decision('part','HEADLIGHTS','这是一只汽车前大灯/雾灯灯泡。')]);
  assert.match(await send('这是什么',[photo]),/车身位置/);
  assert.ok(brain.hasPendingPart('group:test','1'));
});

test('a confirmed rear location and brake function resolve a previously seen lamp',async()=>{
  const {send,brain,calls}=fixture([decision('unclear','','只看到一个灯座。'),decision('unclear','','位置不清。')]);
  await send('这是什么',[photo]);
  await send('也许在后窗中央，踩刹车才亮？');
  assert.ok(brain.hasPendingPart('group:test','1'));
  assert.match(await send('在车顶后缘正中央，踩刹车才亮。'),/根据你补充.+高位制动灯/);
  assert.equal(calls.length,2);
  assert.equal(brain.hasPendingPart('group:test','1'),false);
});

test('multiple plausible engine bay targets need a pointer even when a battery terminal is visible',async()=>{
  const {send,brain}=fixture([decision('part','BATTERY','蓄电池。'),
    JSON.stringify({label:'BATTERY',cue:'battery_post_and_clamp',observation:'右上有电瓶极柱。',targetSelection:'ambiguous',caption:'蓄电池。'})]);
  assert.match(await send('这是什么',[photo]),/指出/);
  assert.ok(brain.hasPendingPart('group:test','1'));
});

test('a molded access panel alone cannot establish that the camera is under the car',async()=>{
  const {send}=fixture([decision('part','ENGINE UNDERTRAY','发动机下护板。'),
    JSON.stringify({label:'ENGINE UNDERTRAY',cue:'removable_underbody_panel',panelLocation:'unknown',observation:'板上有扣手。',caption:'发动机下护板。'}),
    decision('part','TAILGATE TRIM','按你说的位置，这块是后备厢门内衬。')]);
  assert.match(await send('这是什么',[photo]),/装在哪里/);
  assert.match(await send('在行李厢门的内面，拆开才看见线束。'),/门内衬/);
});

test('a nearby light does not override a description of the hatch handle',async()=>{
  const {send,calls}=fixture([decision('unclear','','只能看到灯壳。'),
    decision('part','TAILGATE HANDLE','尾门外把手，拉动时释放门锁。')]);
  await send('这是什么',[photo]);
  assert.match(await send('车尾左侧灯组旁边的把手，从车外拉它能开门。'),/尾门外把手/);
  assert.equal(calls.length,2);
});

test('a rear-only classifier cannot overturn an independently recognized front lamp',()=>{
  const expert={preferred:'HEADLIGHTS',rearComparison:{preferred:'TAILLIGHTS'}};
  assert.equal(galleryChoice({scene:{expert},labels:[]}), 'HEADLIGHTS');
  assert.equal(galleryChoice({scene:{expert:{...expert,preferred:null}},labels:[]}), undefined);
});

test('two ambiguous socket close-ups can be resolved by the user placing the assembly',async()=>{
  const ref={scene:{strong:false,label:'HEADLIGHTS',expert:{preferred:'TAILLIGHTS',rearComparison:{preferred:'TAILLIGHTS'}}},labels:[]};
  const {send,brain}=fixture([decision('unclear','','只有灯座。'),
    JSON.stringify({kind:'part',label:'TAILLIGHTS',landmark:'corner_and_hatch',caption:'补图看到小灯泡，是尾灯。'}),
    decision('part','HEADLIGHTS','根据你给的车头位置，这是前大灯总成。')],ref);
  await send('这是什么',[photo]);
  await send('同一部件另一张照片',[extra]);
  assert.ok(brain.hasPendingPart('group:test','1'));
  assert.match(await send('在前翼子板附近，打开机盖从后面换近光灯泡。'),/前大灯/);
});

test('filter pleats without a mounting landmark lead to a location question and a contextual answer',async()=>{
  const {send,brain,calls}=fixture([decision('part','CABIN FILTER','白色空调滤芯。'),
    JSON.stringify({label:'CABIN FILTER',cue:'element_at_hvac_inlet',filterMount:'unknown',observation:'滤纸和黑色框',caption:'空调滤芯。'}),
    decision('part','AIR FILTER','根据你补充的进气盒位置，这是发动机空气滤清器。')]);
  const question=await send('这是什么',[photo]);
  assert.match(question,/进气盒.*手套箱/);
  assert.match(await send('前者'),/发动机空气滤清器/);
  assert.equal(brain.hasPendingPart('group:test','1'),false);
  assert.ok(calls[2].messages[1].content[0].text.includes('"lastQuestion":'+JSON.stringify(question)));
});

test('when the user cannot give a filter location the next question asks for different evidence',async()=>{
  const {send,brain}=fixture([decision('unclear','','褶状空气滤芯，安装位置不明。'),
    JSON.stringify({kind:'unclear',caption:'车型不清楚。',question:'这个滤芯是从发动机舱的进气盒里取出来的，还是从副驾驶手套箱后面取出来的？'})]);
  await send('这是什么',[photo]);
  assert.match(await send('不记得从哪拆的了'),/盒子.*管道/);
  assert.ok(brain.hasPendingPart('group:test','1'));
});
