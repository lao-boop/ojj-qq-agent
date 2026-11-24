import test from 'node:test';
import assert from 'node:assert/strict';
import {applyBusinessSentenceReview,weighSentenceSuggestion} from '../src/voice-sentence-review.js';
import {VoiceClarifications} from '../src/voice-clarification.js';

const apply=(text,options={})=>applyBusinessSentenceReview({status:'keep'},text,options);

test('按业务语境写出带字母的产品名，尊重已确认的词',()=>{
  assert.equal(apply('请在京东首页搜索京东 一卡').text,'请在京东首页搜索京东E卡');
  assert.equal(apply('健康随意保可以投保吗').text,'健康随e保可以投保吗');
  assert.equal(apply('京东ｅ 卡和京东Ｅ卡').text,'京东E卡和京东E卡');
  assert.equal(apply('采用B two C电商模式').text,'采用B to C电商模式');
  assert.equal(apply('这段口令是B TWO B').text,'这段口令是B TWO B');
  for(const text of ['东京E卡怎么用','京东一卡通可以绑定礼品卡吗','投保资料可以健康随意保存吗','一张卡和两张卡'])
    assert.equal(apply(text).text,text);
  const text='请在京东首页搜索京东一卡';
  assert.equal(apply(text,{protectedWords:['一卡']}).text,text);
});

test('未知含字母的名称需要同音和同位置的独立识别依据',async()=>{
  const text='需要比超检查',issue={heard:'比超',candidate:'B超',kind:'term'};
  const primary=[text,'需要Ｂ超检查','需要 b 超检查'];
  assert.equal((await weighSentenceSuggestion(text,primary,issue)).status,'edit');
  assert.equal((await weighSentenceSuggestion(text,[text,text,'有个B超报告'],issue)).status,'reject');
  assert.equal((await weighSentenceSuggestion('型号是B12',['型号是B13','型号是B13'],{heard:'B12',candidate:'B13',kind:'term'})).status,'reject');
});

test('只有转接对象存在分歧才问，文字确认支持小写和全角字母',async()=>{
  const text='转给一卡客服',primary=[text,'转给伊卡客服'];
  const {field}=apply(text,{primary});
  assert.deepEqual(field.options,['一卡','E卡']);
  const flow=new VoiceClarifications();
  const final=await flow.confirm('client',text,[field],()=>flow.answer('client','是ｅ卡'));
  assert.equal(final,'转给E卡客服');
  assert.equal(apply(text,{primary:[text,text]}).field,undefined);
  assert.equal(apply(text,{primary,protectedWords:['一卡']}).field,undefined);
  assert.equal(apply('转给一卡通客服',{primary}).field,undefined);
});
