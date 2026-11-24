"""Supplementary acoustic readings for the Mandarin word selector."""
from pathlib import Path
from functools import lru_cache
import math
import json
import re
from difflib import SequenceMatcher
import numpy as np
from asr_context import Surface, disagreements, number_value

MODEL_DIR = Path(__file__).resolve().parents[1]/"data/models"
PARAFORMER = MODEL_DIR/"sherpa-onnx-paraformer-zh-2023-09-14"
ZIPFORMER = MODEL_DIR/"sherpa-onnx-zipformer-ctc-zh-int8-2025-07-03"
FUNASR = MODEL_DIR/"sherpa-onnx-funasr-nano-int8-2025-12-30"


class AcousticReader:
    def __init__(self, name):
        from sherpa_onnx import OfflineRecognizer
        if name == "paraformer":
            self.model = OfflineRecognizer.from_paraformer(
                paraformer=str(PARAFORMER/'model.int8.onnx'), tokens=str(PARAFORMER/'tokens.txt'), num_threads=2)
        elif name == "zipformer":
            self.model = OfflineRecognizer.from_zipformer_ctc(
                model=str(ZIPFORMER/'model.int8.onnx'), tokens=str(ZIPFORMER/'tokens.txt'), num_threads=2)
        elif name == "funasr":
            self.model = OfflineRecognizer.from_funasr_nano(
                encoder_adaptor=str(FUNASR/'encoder_adaptor.int8.onnx'), llm=str(FUNASR/'llm.int8.onnx'),
                embedding=str(FUNASR/'embedding.int8.onnx'), tokenizer=str(FUNASR/'Qwen3-0.6B'),
                num_threads=3, max_new_tokens=192, seed=42, temperature=1e-6)
        else:
            raise ValueError(f"Unknown supplementary recognizer {name}")

    def read(self, wave, speed=1.0):
        if speed!=1.0:
            wave=np.interp(np.arange(0,len(wave),speed),np.arange(len(wave)),wave).astype(np.float32)
        stream=self.model.create_stream()
        stream.accept_waveform(16000,wave)
        self.model.decode_stream(stream)
        return stream.result.text.strip()


def touches_field(start, end, field):
    if start==end:
        return field["start"] <= start <= field["end"]
    return start < field["end"] and end > field["start"]


@lru_cache(maxsize=2048)
def lexicon_score(fragment):
    import jieba
    words=[w for w in jieba.cut(fragment) if w.strip()]
    # A small signal for word boundaries; rare names can still win on acoustic evidence.
    return sum(min(12.,math.log1p(jieba.get_FREQ(w) or 0))*min(len(w),3) for w in words)/max(len(fragment),1)


def observations(wave, base, originals, extra, questions, context, acoustic):
    surfaces = [Surface(t or '') for t in (base,*originals,*extra)]
    absent = {i for i,s in enumerate(surfaces) if i and not s.tokens}
    if extra[-1] is None:
        # A nearly unrelated supplementary hypothesis can hide short local edits
        # by removing every common alignment anchor. Its family must not vote twice.
        for i in (4,5,6):
            peer_ids = (0,1,2,3,6) if i in (4,5) else (0,1,2,3,4)
            if all(SequenceMatcher(None,surfaces[i].tokens,surfaces[j].tokens,autojunk=False).ratio()<.42
                   for j in peer_ids):
                absent.add(i)
    for i in absent:
        surfaces[i]=surfaces[0]
    result=[]
    for start,end,choices in disagreements(surfaces,preserve_first_three=False):
        a,b=surfaces[0].bounds(start,end)
        if any(touches_field(a,b,q) for q in questions):
            continue
        for c in choices:
            for i in absent:
                c["support"][i]=0
            c["lm"]=context.likelihood(base[:a],c["text"],base[b:])
            c["lex"]=lexicon_score(base[max(0,a-4):a]+c["text"]+base[b:b+4])
        result.append(dict(left=a,right=b,choices=choices))
    if result: acoustic.annotate(wave,base,result)
    add_reliability(result)
    return result


NUM = re.compile(r"[0-9]+(?:\.[0-9]+)?|[零〇一二两三四五六七八九十百千万亿]+")


def add_reliability(segments):
    # Agreement with other recognizers elsewhere in this particular utterance.
    # Two speed variants of a model count as one family.
    families=(1,2,3,4,6)
    agreement=[]
    for seg in segments:
        picks=[next((c for c in seg['choices'] if c['support'][m]),None) for m in families]
        agreement.append(np.array([(sum(c['support'][i] for i in families)-1)/4 if c else 0. for c in picks]))
    total=sum(agreement,np.zeros(5))
    for seg,local in zip(segments,agreement):
        seg['reliability']=((total-local)/(1+len(segments))).tolist()


def signals(base, seg, c):
    prior,f,q,s,p,p2,z,z2 = c["support"]
    a,b=seg["left"],seg["right"]
    choices=seg["choices"]
    t=c["text"]
    numeric=[number_value(x["text"]) for x in choices]
    same_number=None not in numeric and len(set(numeric))==1
    has_num=NUM.search(t) is not None
    digit=bool(re.search(r"[0-9]",t))
    latin=bool(re.search(r"[a-zA-Z]",t))
    other_nums=NUM.findall(base[:a]+' '+base[b:])
    nearby_style=(sum(bool(re.search(r'[0-9]',n)) for n in other_nums)/len(other_nums)-.5) if other_nums else 0.
    diff_lm=max(-8.,c["lm"]-max(x["lm"] for x in choices))/3
    diff_lex=(c["lex"]-max(x["lex"] for x in choices))/4
    acoustic=c.get("acoustic",0)/4
    length=max(1,len(base))
    word_change=not same_number
    families=f+q+s+max(p,p2)+max(z,z2)
    core = [
        prior,f,q,s,p,z,p*p2,z*z2,(p+p2)/2,(z+z2)/2,
        families/5, (p*p2)*(z*z2), f*q, q*z, prior*word_change,
        diff_lm,acoustic,diff_lex, float(not t),min(len(t),12)/6,
        same_number*digit, same_number*f,same_number*q,same_number*max(p,p2),same_number*max(z,z2),
        digit*nearby_style, digit*bool(re.search(r"[a-zA-Z]",base)),digit*bool(re.match(r"年|月|日",base[b:])),
        latin*max(p,p2),latin*max(z,z2),latin*q, has_num*digit,
        min(1.,(b-a)/length)*prior, float(latin),diff_lm*bool(seg.get("ctc_confidence",0)>.5),
    ]
    relative=seg.get('reliability',[0.]*5)
    core.extend(v*(r-sum(relative)/5) for v,r in zip((f,q,s,max(p,p2),max(z,z2)),relative))
    digits_in_sequence=re.fullmatch(r"[零〇一二两三四五六七八九]+",t) is not None and len(t)>1
    core.extend([digit*same_number*(len(t)>=3),digit*same_number*(base[max(0,a-1):a]=='第'),
                 digit*same_number*bool(re.match(r"元|块|米|公斤|厘米|毫米|千米|公里|英里|英尺|%|％",base[b:])),
                 digit*same_number*bool(re.search(r"到|至|百分之",base[max(0,a-4):b+3])),
                 digits_in_sequence*same_number,diff_lm*(p or z),diff_lex*(p or z)])
    return core


def transition(base, previous, current, before, now):
    bridge=base[previous['right']:current['left']]
    if len(bridge)>6 or re.search(r"[。！？!?，,；;]",bridge):
        return 0.
    # Penalize splicing two adjacent variants that no single decoder actually produced.
    joined=any(a and b for a,b in zip(before['support'],now['support']))
    value=0. if joined else -1./(1+len(bridge)/3)
    if (number_value(before['text']) is not None and number_value(now['text']) is not None
            and re.fullmatch(r"(?:到|至|和|或|年|月|点到|[-—~～])",bridge)):
        if before['text'].isascii()!=now['text'].isascii():
            value-=1.
    return value


def best_choices(base,segments,scores,margin,coherence):
    if not segments:
        return []
    best=[]
    links=[]
    for n,(seg,row) in enumerate(zip(segments,scores)):
        next_best=[]; parents=[]
        for j,c in enumerate(seg['choices']):
            score=row[j]-(margin if j else 0.)
            parent=0
            if n:
                prev=segments[n-1]
                values=[v+coherence*transition(base,prev,seg,p,c) for v,p in zip(best,prev['choices'])]
                parent=max(range(len(values)),key=values.__getitem__)
                score+=values[parent]
            parents.append(parent);next_best.append(score)
        links.append(parents);best=next_best
    j=max(range(len(best)),key=best.__getitem__)
    path=[]
    for layer in reversed(links):
        path.append(j);j=layer[j]
    return path[::-1]


def materialize(base,questions,segments,path):
    edits=[(seg['left'],seg['right'],seg['choices'][j]['text']) for seg,j in zip(segments,path) if j]
    shifted=[]
    for q in questions:
        delta=sum(len(t)-(b-a) for a,b,t in edits if b<=q['start'])
        shifted.append(dict(q,start=q['start']+delta,end=q['end']+delta))
    for a,b,t in reversed(edits):
        base=base[:a]+t+base[b:]
    if any(base[q['start']:q['end']]!=q['options'][0] for q in shifted):
        raise ValueError("A direct edit overlapped a confirmation")
    return base,shifted


_INTEGER = r"(?:[0-9]+|[零〇一二两三四五六七八九十百千万亿]+)"
_DATE = re.compile(r"(?:(?P<year>[0-9]{4})年\s*)?(?P<month>"+_INTEGER+r")月(?:\s*(?P<day>"+_INTEGER+r")[日号])?")
_RANGE = re.compile(r"(?P<lo>"+_INTEGER+r")(?P<unit>点钟|点|时|米|岁|元|年|天|分钟|小时)?\s*(?:到|至|～|~|—)\s*(?P<hi>"+_INTEGER+r")(?=(?:点|时|岁|元|人|个|年|月|日|天|份|只|件|米|公|厘|毫|英|分钟|小时|%|％))")


def consistent_numbers(base, questions, enabled):
    """Keep digit style consistent inside a single linked date or measured range."""
    edits={}
    if 'date' in enabled:
        for match in _DATE.finditer(base):
            month,day=match['month'],match['day']
            if not (match['year'] or (day and (month.isascii() or day.isascii()))):
                continue
            for name,limit in (('month',12),('day',31)):
                raw=match[name]
                value=number_value(raw) if raw else None
                if value and raw!=value and 1<=int(value)<=limit:
                    edits[match.span(name)]=value
    if 'range' in enabled:
        for match in _RANGE.finditer(base):
            if match.start() and base[match.start()-1] in ".．负+-":
                continue
            lo,hi=(number_value(match[n]) for n in ('lo','hi'))
            if lo is None or hi is None or int(lo)>int(hi):
                continue
            if not (match['lo'].isascii() or match['hi'].isascii() or int(lo)>=10):
                continue
            for name,value in (('lo',lo),('hi',hi)):
                if match[name]!=value:
                    edits[match.span(name)]=value
    segments=[]
    for (a,b),value in sorted(edits.items()):
        if not any(touches_field(a,b,q) for q in questions):
            segments.append(dict(left=a,right=b,choices=[{},dict(text=value)]))
    return materialize(base,questions,segments,[1]*len(segments))


_HOMOPHONES={'他':'他它','她':'她它','它':'它他','的':'的地得','地':'的地得','得':'的地得','在':'在再','再':'在再'}


def homophone_evidence(base, questions, context):
    """Compare single-character homophones in the same masked context."""
    items=[]
    for m in re.finditer('[他她它的地得在再]',base):
        k=m.start()
        if any(touches_field(k,k+1,q) for q in questions):
            continue
        original=m[0]
        if original in '他她它' and (k==0 or base[k-1:k]=='其'):
            continue
        tokenizer=context.tokenizer
        before=tokenizer.encode(base[max(0,k-48):k],add_special_tokens=False).ids
        after=tokenizer.encode(base[k+1:k+49],add_special_tokens=False).ids
        pos=len(before)+1
        ids=[tokenizer.token_to_id('[CLS]'),*before,context.mask,*after,tokenizer.token_to_id('[SEP]')]
        items.append((k,original,pos,ids))
    results=[]
    for start in range(0,len(items),4):
        batch=items[start:start+4]
        width=max(len(ids) for _,_,_,ids in batch)
        data=np.zeros((len(batch),width),dtype=np.int64)
        mask=np.zeros_like(data)
        for idx,(_,_,_,ids) in enumerate(batch):
            data[idx,:len(ids)]=ids
            mask[idx,:len(ids)]=1
        pred=context.model.run(None,dict(input_ids=data,attention_mask=mask,token_type_ids=np.zeros_like(data)))[0]
        for idx,(k,original,pos,_) in enumerate(batch):
            group=_HOMOPHONES[original]
            scores={ch:float(pred[idx,pos,context.tokenizer.token_to_id(ch)]) for ch in group}
            best=max(scores,key=scores.get)
            if best!=original:
                key='pronoun' if original in '他她它' else ('particle' if original in '的地得' else 'zai')
                results.append((k,best,key,scores[best]-scores[original]))
    return results


def apply_homophones(text,fields,items,thresholds):
    pieces=[dict(left=k,right=k+1,choices=[{},dict(text=ch)])
            for k,ch,kind,gap in items if kind in thresholds and gap>=thresholds[kind]]
    return materialize(text,fields,pieces,[1]*len(pieces))


def apply_choices(base, questions, segments, weights, margin, coherence=0.):
    scores=[[sum(w*x for w,x in zip(weights,signals(base,seg,c)[:len(weights)],strict=True)) for c in seg['choices']]
            for seg in segments]
    path=best_choices(base,segments,scores,margin,coherence)
    return materialize(base,questions,segments,path)


def configured_policy():
    path=MODEL_DIR/"mandarin-direct.json"
    if not path.exists():
        return None
    policy=json.loads(path.read_text("utf-8-sig"))
    penalties=np.asarray([policy["margin"],policy["coherence"]],dtype=float)
    style=policy.get('number_style',[])
    gates=policy.get('homophones',{})
    if (policy.get("version")!=1 or policy.get("readers") not in (["paraformer","zipformer"],["paraformer","funasr"])
            or policy.get("speeds")!=[1.,.96] or len(policy["weights"]) not in (35,47)
            or not isinstance(style,list) or any(k not in ('date','range') for k in style)
            or not isinstance(gates,dict) or any(k not in ('pronoun','particle','zai') or
                    not isinstance(v,(int,float)) or not math.isfinite(v) or v<=0 for k,v in gates.items())
            or not np.isfinite(policy["weights"]).all() or not np.isfinite(penalties).all() or (penalties<0).any()):
        raise ValueError("Unsupported direct selection policy")
    files = {"paraformer": (PARAFORMER,("model.int8.onnx","tokens.txt")),
             "zipformer": (ZIPFORMER,("model.int8.onnx","tokens.txt")),
             "funasr": (FUNASR,("encoder_adaptor.int8.onnx","embedding.int8.onnx","llm.int8.onnx",
                                  "Qwen3-0.6B/tokenizer.json","Qwen3-0.6B/vocab.json","Qwen3-0.6B/merges.txt"))}
    for name in policy["readers"]:
        directory,names=files[name]
        if not all((directory/n).is_file() for n in names):
            raise FileNotFoundError(directory)
    review_path=MODEL_DIR/'mandarin-word-review.json'
    if review_path.is_file() and policy['readers']==['paraformer','zipformer']:
        from asr_candidate_choice import validate_rules
        directory,names=files['funasr']
        if all((directory/n).is_file() for n in names):
            policy['candidate_review']=validate_rules(json.loads(review_path.read_text('utf-8-sig')))
    if policy.get('semantic_review') and not (MODEL_DIR/'Qwen2.5-3B-Instruct-GGUF/qwen2.5-3b-instruct-q4_k_m.gguf').is_file():
        policy['semantic_review']=False
    return policy


class DirectSelector:
    def __init__(self, policy):
        self.policy=policy
        self.loaded=None
        self.reader=None

    def readings(self,wave):
        # Reuse the last recognizer first. Keep only one supplementary model resident.
        order=sorted(self.policy["readers"],key=lambda name:name!=self.loaded)
        outputs={}
        for name in order:
            if self.loaded!=name:
                self.reader=None
                self.loaded=None
                self.reader=AcousticReader(name)
                self.loaded=name
            speeds=(1.,) if name=="funasr" else self.policy["speeds"]
            outputs[name]=[self.reader.read(wave,speed) for speed in speeds]
        return self.combine(outputs)

    def combine(self,outputs):
        a,b=self.policy["readers"]
        return outputs[a]+outputs[b]+([None] if b=="funasr" else [])

    def resolve(self,wave,texts,selector,extra=None,release_decoder=None,corroborating_read=None,readings_out=None,primary_out=None):
        from asr_clarification import clarification_fields
        evidence=[]
        if Surface(texts[0]).tokens==Surface(texts[1]).tokens==Surface(texts[2]).tokens:
            base,questions=texts[0],[]
        else:
            base=selector.select(wave,texts,evidence)
            questions=clarification_fields(base,texts,evidence)
        if extra is None:
            extra=self.readings(wave)
        if readings_out is not None:
            readings_out.extend(dict.fromkeys(t for t in [*texts,*extra] if t))
        if primary_out is not None:
            primary_out.extend(t for t in [*texts,extra[0],extra[2]] if t)
        if not all(extra[i] for i in (0,2)):
            return base,questions
        pieces=observations(wave,base,texts,extra,questions,selector.context,selector.acoustic)
        text,fields=apply_choices(base,questions,pieces,self.policy["weights"],self.policy["margin"],self.policy["coherence"])
        text,fields=consistent_numbers(text,fields,self.policy.get("number_style",[]))
        thresholds=self.policy.get("homophones",{})
        if thresholds:
            homophones=homophone_evidence(text,fields,selector.context)
            text,fields=apply_homophones(text,fields,homophones,thresholds)
        rules=self.policy.get('candidate_review')
        if rules:
            from asr_candidate_choice import core_scores,review
            def free_decoders():
                self.loaded=None
                self.reader=None
                if release_decoder:release_decoder()
            @lru_cache(maxsize=1)
            def corroborate():
                if corroborating_read:return corroborating_read()
                free_decoders()
                try:
                    return AcousticReader('funasr').read(wave)
                except (RuntimeError,OSError,MemoryError):
                    return ''
            core=core_scores(base,text,evidence)
            donors=[*texts,extra[0],extra[2]]
            text,fields=review(text,fields,donors,rules,core,corroborate)
            if self.policy.get('semantic_review'):
                from asr_semantic import prepare,annotate,decide
                segments=prepare(text,fields,core_scores(base,text,evidence),donors)
                if segments:
                    free_decoders()
                    try:
                        annotate(text,segments)
                    except (RuntimeError,ValueError,ImportError,OSError,MemoryError) as error:
                        import logging
                        logging.getLogger(__name__).warning("Semantic review unavailable: %s",error)
                    else:
                        text,fields,_=decide(text,fields,segments,corroborate)
        return text,fields
