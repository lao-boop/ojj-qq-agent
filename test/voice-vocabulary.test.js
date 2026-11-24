import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {VoiceNames,resolveVoiceVocabulary} from '../src/voice-vocabulary.js';
import {VoiceFollowups,conversationalFields} from '../src/voice-clarification.js';
import {semanticFields} from '../src/voice-review.js';
import {verifyPublicName} from '../src/voice-place-evidence.js';

function profile(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'voice-names-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return new VoiceNames(path.join(directory,'names.json'));
}
test('文物名须有来源正文和同音候选，标题或摘要不能独立改字',async t=>{
  const names=profile(t);
  const text='中国国家博物馆收藏的四洋方尊';
  const search=async()=>[{title:'四羊方尊',snippet:'中国国家博物馆收藏四羊方尊',url:'https://www.chnmuseum.cn/test'}];
  const result=await resolveVoiceVocabulary(names,'a',text,[],search,{openArticle:async()=>'商代四羊方尊'});
  assert.equal(result.text,text.replace('四洋','四羊'));
  assert.equal(result.places[0].url,'https://www.chnmuseum.cn/test');
  const empty=await resolveVoiceVocabulary(names,'a',text,[],search,{openArticle:async()=>''});
  assert.equal(empty.text,text);
  assert.deepEqual(empty.places,[]);
});
test('展厅来源支持两种同音拼法时，已有词库不能越过冲突改写',async t=>{
  const text='玉厅展示了孔子周游列国的经历';
  const result=await resolveVoiceVocabulary(profile(t),'a',text,[],async()=>[
    {title:'展览',url:'https://example.edu.cn/halls'}
  ],{openArticle:async()=>'孔子周游列国展览分设御厅和玉厅。'});
  assert.equal(result.text,text);
  assert.deepEqual(result.culturalEdits,[]);
});
test('纠正过的人名按说话人保存，重名或同音冲突时保留原字',t=>{
  const names=profile(t), corrections=new VoiceFollowups();
  corrections.remember('a','问问李刚明天几点到');
  const repair=corrections.handle('a','人名是李钢，不是李刚');
  assert.match(repair.context,/问问李钢明天几点到/);
  names.add('a',repair.name,repair.heard);
  const reloaded=new VoiceNames(names.file);
  assert.equal(reloaded.correct('a','李刚明天十点到',[]).text,'李钢明天十点到');
  assert.equal(reloaded.correct('b','李刚明天十点到',[]).text,'李刚明天十点到');
  reloaded.add('a','李纲','李刚');
  assert.equal(reloaded.correct('a','李刚明天十点到',[]).text,'李刚明天十点到');
  assert.equal(corrections.handle('b','不是李刚，是李钢'),null);
});

test('地名核验从事件来源正文找写法，两个候选同时成立时保留原文',async()=>{
  const focus={term:'长宁',options:['长宁','常宁'],known:true,topics:['救护车','捐赠']};
  const search=async()=>[{title:'公益项目进展',url:'https://example.gov.cn/event'}];
  const result=await verifyPublicName(focus,search,async()=>'本次捐赠的救护车交付给常宁。');
  assert.equal(result.value,'常宁');
  assert.match(result.places[0].excerpt,/常宁/);
  const both=await verifyPublicName(focus,search,async()=>'长宁和常宁分别接收了此次捐赠的救护车。');
  assert.equal(both.value,'长宁');
  assert.equal(both.ambiguous,true);
});

test('允许从可核实的正文发现声学候选外的同音写法，仅有关联的语境才能改字',async()=>{
  const focus={term:'月溪公园',options:['月溪公园'],topics:['景观','展览']};
  const search=async()=>[{title:'活动公告',url:'https://example.gov.cn/park'}];
  assert.equal((await verifyPublicName(focus,search,async()=>'越溪公园举办了景观展览。')).value,'越溪公园');
  assert.equal((await verifyPublicName(focus,search,async()=>'越溪公园开放。')).value,'月溪公园');
  assert.equal((await verifyPublicName(focus,async()=>[{title:'越溪公园景观展览',url:'https://invalid.test/park'}],
    async()=>assert.fail('不应抓取未知来源'))).value,'月溪公园');
});
test('普通用词结合整句选择，办理事项仍保留原追问',async t=>{
  const names=profile(t);
  const text='孩子手里拿着波浪鼓';
  const f={start:6,end:9,label:'用词',options:['波浪鼓','拨浪鼓']};
  assert.deepEqual(conversationalFields(text,[f]),[]);
  assert.deepEqual(conversationalFields('下单给他订一个波浪鼓',[f]),[f]);
  const result=await resolveVoiceVocabulary(names,'a',text,[f],async()=>[],{judge:async(s,fs)=>{
    assert.equal(s,text);assert.equal(fs.length,1);return ['拨浪鼓'];
  }});
  assert.equal(result.text,'孩子手里拿着拨浪鼓');
});
test('地名以相同读音和政府来源核验，家庭地址不发送检索',async t=>{
  const names=profile(t);
  const hits=async q=>{
    assert.equal(q,'中山瞻园 site:gov.cn');
    return [{title:'中山詹园 - 中山市人民政府',url:'https://www.zs.gov.cn/example'}];
  };
  const r=await resolveVoiceVocabulary(names,'a','图为中山瞻园广邀千余游客',[],hits);
  assert.equal(r.text,'图为中山詹园广邀千余游客');
  const address=await resolveVoiceVocabulary(names,'a','我家住在中山瞻园',[],async()=>assert.fail('不应联网'));
  assert.equal(address.queries.length,0);
});

test('将未触发追问的同音声学分歧交给整句选词',async t=>{
  const names=profile(t);
  const sentence='这艘游轮装满原油正在进港';
  const alternative='这艘油轮装满原油正在进港';
  const result=await resolveVoiceVocabulary(names,'demo',sentence,[],async()=>[],{
    readings:[sentence,alternative],
    judge:async(text,fields)=>{
      assert.equal(text,sentence);
      return fields.map(f=>f.options.find(v=>v.includes('油')));
    }
  });
  assert.equal(result.text,alternative);
  assert.deepEqual(semanticFields(sentence,[],[sentence]),[]);
  assert.deepEqual(semanticFields(sentence,[{start:2,end:4}], [alternative]),[]);
});

test('办理事项遇到两个同音行政区时保留歧义，叙述句不打断',async t=>{
  const profileNames=profile(t);
  const none=async()=>[];
  const action=await resolveVoiceVocabulary(profileNames,'demo','请帮我导航到宜良',[],none);
  assert.ok(action.geoQuestions[0].options.includes('彝良'));
  const story=await resolveVoiceVocabulary(profileNames,'demo','向宜良捐赠救护车',[],none);
  assert.equal(story.geoQuestions.length,0);
  assert.equal(story.text,'向宜良捐赠救护车');
  assert.match(story.focusedQuery,/彝良/);
});
