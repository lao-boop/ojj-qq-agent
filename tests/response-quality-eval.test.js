import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeReview, renderQualityReport } from '../scripts/response-quality-report.mjs';
import { QUALITY_RUBRIC } from '../scripts/response-quality-cases.mjs';

const review=()=>({scores:Object.fromEntries(Object.keys(QUALITY_RUBRIC.axes).map(k=>[k,2])),rationale:'Output preserves all provided values.'});
test('service errors and unreviewed results cannot inflate satisfaction',()=>{
  assert.equal(judgeReview({status:'service_error'},review()).status,'service_error');
  assert.equal(judgeReview({status:'unreviewed'}).status,'unreviewed');
  const report={manifest:{suiteHash:'test'},cases:[{id:'a',criteria:[],turns:[]},{id:'b',criteria:[],turns:[]}],results:[{id:'a',status:'service_error'}]};
  const {summary}=renderQualityReport(report,{a:review()});
  assert.equal(summary.satisfactoryRate,null);assert.equal(summary.counts.unrun,1);assert.equal(summary.counts.service_error,1);
});
test('a critical error or a zero dimension fails even when the sum reaches ten',()=>{
  const r=review();r.scores.accuracy=0;
  assert.equal(judgeReview({},r).total,10);assert.equal(judgeReview({},r).status,'needs_work');
  assert.equal(judgeReview({},{...review(),critical:true}).status,'needs_work');
  assert.equal(judgeReview({},review()).status,'satisfactory');
});
test('incomplete or unsupported reviewer scores are rejected',()=>{
  const r=review();delete r.scores.honesty;
  assert.throws(()=>judgeReview({},r),/Invalid review/);
  assert.throws(()=>judgeReview({},{...review(),rationale:''}),/Invalid review/);
});
