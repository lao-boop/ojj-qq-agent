"""Use sentence context to choose among acoustically observed Mandarin words."""
from difflib import SequenceMatcher
import re

from asr_candidate_choice import project,render
from asr_context import Surface
from asr_direct import touches_field
from asr_clarification import NAME, IDENTIFIER, QUANTITY


def tokens_in(base, donor, start, end):
    mapping=SequenceMatcher(None,base.tokens,donor.tokens,autojunk=False).get_opcodes()
    bounds=project(mapping,start,end)
    return None if bounds is None else tuple(donor.tokens[bounds[0]:bounds[1]])


def prepare(text,fields,core,readings):
    base=Surface(text)
    starts={a:i for i,(a,b) in enumerate(base.offsets)}
    stops={b:i+1 for i,(a,b) in enumerate(base.offsets)}
    protected=list(fields)
    for pattern in (NAME,IDENTIFIER,QUANTITY):
        protected.extend(dict(start=m.start(),end=m.end()) for m in pattern.finditer(text))
    donors=[Surface(t) for t in readings]
    segments=[]
    for (a,b),opts in core.items():
        if a not in starts or b not in stops or any(touches_field(a,b,f) for f in protected):continue
        if len(text)-(b-a)<8:continue
        old=text[a:b]
        # Restrict the judge to complete spoken Han alternatives, protecting numeric
        # values, codes, deletions and formatting previously resolved by the ASR.
        words=sorted(opts.values(),key=lambda c:c['support'].index(1))
        if not (2<=len(words)<=3 and all(re.fullmatch(r'[\u3400-\u9fff]{1,8}',c['text']) for c in words)):continue
        if old not in [c['text'] for c in words] or any(re.search('[零〇一二两三四五六七八九十百千万亿]',c['text']) for c in words):continue
        start,end=starts[a],stops[b]
        votes=[tokens_in(base,src,start,end) for src in donors]
        choices=[dict(text=c['text'],votes=votes.count(tuple(Surface(c['text']).tokens))) for c in words]
        old_votes=next(c['votes'] for c in choices if c['text']==old)
        alt_votes=max(c['votes'] for c in choices if c['text']!=old)
        if old_votes>=4 or not alt_votes:continue
        if len(choices)==2 and max(len(c['text']) for c in choices)==1 and alt_votes<2:continue
        segments.append(dict(left=a,right=b,start=start,end=end,old=old,choices=choices))
    # Limit latency and prioritize the most disputed span. The protected question
    # is carried through any substitutions using its original options.
    def priority(s):
        cs=s['choices']
        current=next(c for c in cs if c['text']==s['old'])
        return (len(cs),max(c['votes'] for c in cs if c!=current)-current['votes'],s['right']-s['left'])
    return sorted(segments,key=priority,reverse=True)[:2]


def decide(text,fields,segments,listen):
    edits=[]
    extra=None
    for seg in segments:
        top,second,*_=sorted(seg['choices'],key=lambda c:-c['judge'])
        if top['text']==seg['old'] or not top['both_orders'] or top['judge']-second['judge']<4:continue
        if top['votes']<2:
            if extra is None:extra=Surface(listen() or '')
            observed=tokens_in(Surface(text),extra,seg['start'],seg['end'])
            if not top['votes'] or observed!=tuple(Surface(top['text']).tokens):continue
        edits.append(dict(left=seg['left'],right=seg['right'],new=top['text'],old=seg['old']))
    edits.sort(key=lambda e:e['left'])
    result,qs=render(text,fields,edits)
    return result,qs,edits


def annotate(text,segments):
    from asr_language_judge import LanguageJudge
    judge=LanguageJudge()
    try:
        judge.annotate(text,segments)
    finally:
        judge.model.close()
