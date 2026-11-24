import {alternativesAt, sound} from './voice-review.js';

// Limit each reading to its documented context. A matching topic alone is
// insufficient: the selected transcript or an aligned ASR candidate must agree in sound.
const entries = [
  {
    value: '错银编磬铜虡兽座',
    topic: /大云山|江都王陵/u,
    span: /(?<word>[\p{Script=Han}]{6}兽座)/dgu,
    source: 'https://www.sohu.com/a/209401656_556515',
  },
  {
    value: '御厅',
    topic: /六艺城|孔子.{0,6}周游列国/u,
    span: /(?<word>[\p{Script=Han}]厅)(?=展示|陈列|再现|展出|参观|乘车)/dgu,
    source: 'https://shandong-chorography.org/database/g0/section/47/article/53/',
  },
  {
    value: '有关方',
    topic: /达尔富尔/u,
    span: /(?:因为|由于)(?<word>有[\p{Script=Han}]{2})(?=的举动而复杂化)/dgu,
    source: 'https://my.china-embassy.gov.cn/fyrth/200807/t20080717_1740976.htm',
  },
  {
    value: '规条字',
    topic: /[号號]/u,
    span: /[0-9零〇一二三四五六七八九]{4}(?<word>规条[\p{Script=Han}])(?=第?[0-9零〇一二三四五六七八九十]{1,8}号)/dgu,
    source: 'https://wwj.beijing.gov.cn/bjww/362679/362680/482911/xxgkgzdt/1783897/index.html',
  },
];

export function applyCulturalTerms(transcript, readings = [], protectedSpan) {
  const edits = [];
  for (const clause of transcript.matchAll(/[^。！？；，、\n]+/gu)) {
    for (const entry of entries) {
      if (!entry.topic.test(clause[0])) continue;
      for (const match of clause[0].matchAll(entry.span)) {
        const heard = match.groups.word;
        if (heard === entry.value) continue;
        const offset = clause.index + match.indices.groups.word[0];
        const start = [...transcript.slice(0, offset)].length;
        const end = start + [...heard].length;
        if (protectedSpan && start < protectedSpan.end && end > protectedSpan.start) continue;
        const candidates = [heard, ...alternativesAt(transcript, start, end, readings)];
        if (candidates.some(candidate => sound(candidate) === sound(entry.value))) {
          edits.push({start, end, heard, value: entry.value, source: entry.source});
        }
      }
    }
  }
  const chars = [...transcript];
  for (const edit of edits.sort((a,b) => b.start - a.start)) {
    chars.splice(edit.start, edit.end - edit.start, ...edit.value);
  }
  return {text: chars.join(''), edits};
}
