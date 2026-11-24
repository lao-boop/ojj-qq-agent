"""Review independently aligned candidate spans after the first word-selection pass."""
from difflib import SequenceMatcher
import re

from asr_context import Surface, number_value
from asr_direct import materialize, touches_field


def project(opcodes, a, b):
    """Map complete edit boundaries. A boundary inside a replacement is ambiguous."""
    left = []
    right = []
    for tag,x,y,u,v in opcodes:
        for pos, hits in ((a,left),(b,right)):
            if x==pos: hits.append(u)
            if y==pos: hits.append(v)
            if tag=='equal' and x<pos<y: hits.append(u+pos-x)
    if not left or not right:
        return None
    return min(left), max(right)


def numeric_form(raw):
    t=raw.strip()
    if t.startswith('百分之'):
        return ('percent',number_value(t[3:])) if number_value(t[3:]) is not None else None
    if t.endswith(('%','％')):
        return ('percent',number_value(t[:-1])) if number_value(t[:-1]) is not None else None
    n=number_value(t)
    return ('integer',n) if n is not None else None


def core_scores(original, text, evidence):
    mapping=SequenceMatcher(None,original,text,autojunk=False).get_opcodes()
    lookup={}
    for s in evidence:
        bounds=project(mapping,s['start'],s['end'])
        if bounds:
            lookup[bounds]={tuple(Surface(c['text']).tokens):c for c in s['choices']}
    return lookup


def collect(text, fields, donors, core=None):
    base=Surface(text)
    sources=[Surface(s) for s in donors]
    def canonical(surface):
        return [numeric_form(t) or t for t in surface.tokens]
    base_values=canonical(base)
    mismatch=[]
    for src in sources:
        seq=canonical(src)
        ops=SequenceMatcher(None,base_values,seq,autojunk=False).get_opcodes()
        mismatch.append(sum(max(b-a,v-u) for tag,a,b,u,v in ops if tag!='equal'))
    alignments=[SequenceMatcher(None,base.tokens,s.tokens,autojunk=False).get_opcodes() for s in sources]
    spans=sorted({(a,b) for ops in alignments[:5] for tag,a,b,_,_ in ops if tag!='equal'})
    # Also compare a donor's complete sequence of numerical spellings. The user
    # may have dictated several quantities in the same sentence.
    joint=set()
    for s,ops in zip(sources[:5],alignments[:5]):
        changed=[(a,b,u,v) for tag,a,b,u,v in ops if tag!='equal']
        if len(changed)<2:continue
        if all(numeric_form(base.surface(a,b)) is not None and
               numeric_form(base.surface(a,b))==numeric_form(s.surface(u,v)) for a,b,u,v in changed):
            joint.add((changed[0][0],changed[-1][1]))
    spans=sorted(set(spans)|joint)
    rows=[]
    for a,b in spans:
        l,r=base.bounds(a,b)
        if any(touches_field(l,r,q) for q in fields):continue
        initial=tuple(base.tokens[a:b])
        options={initial:text[l:r]}
        local=[]
        for src,ops in zip(sources,alignments):
            mapped=project(ops,a,b)
            if mapped is None:
                local.append(None)
                continue
            u,v=mapped
            key=tuple(src.tokens[u:v])
            options.setdefault(key,src.surface(u,v))
            local.append(key)
        base_num=numeric_form(options[initial])
        for key,word in options.items():
            if key==initial:continue
            support=[int(k==key) for k in local]
            if not any(support[:5]):continue
            against=[int(k==initial) for k in local]
            whole=[int(s.tokens==base.tokens[:a]+list(key)+base.tokens[b:]) for s in sources]
            kind='lexical'
            if base_num is not None and numeric_form(word)==base_num:
                if base_num[0]=='percent':kind='percent'
                elif text[r:r+1]=='年' and re.fullmatch('[12][0-9]{3}',base_num[1]):kind='year'
                elif int(base_num[1])<10:
                    kind='classifier' if re.match('名|位|个|家|本|只|条|人|件|台|部|张|座',text[r:]) else 'small'
                elif re.match('名|位|个|家|本|只|条|人|件|台|部|张|座',text[r:]):kind='count'
                elif int(base_num[1])>=100 and int(base_num[1])%100==0:kind='round'
                else:kind='quantity'
            elif (a,b) in joint:
                # Recompute with local offsets to compare only the changed numbers.
                segment=Surface(options[initial])
                other=Surface(word)
                pairs=[(segment.surface(x,y),other.surface(u,v)) for tag,x,y,u,v in
                       SequenceMatcher(None,segment.tokens,other.tokens,autojunk=False).get_opcodes() if tag!='equal']
                if len(pairs)>1 and all(numeric_form(x) and numeric_form(x)==numeric_form(y) for x,y in pairs):
                    # Ranges and calendar dates have already been formatted together.
                    bridge=''.join(t for t in segment.tokens if numeric_form(t) is None)
                    if re.fullmatch(r'(?:年|月|日|点|时|到|至|分|分钟|小时|又|分之)+',bridge):continue
                    kind='number_sequence'
            elif options[initial] in ('他','它','她') and word in ('他','它','她'):
                kind='pronoun'
            if kind=='lexical':
                if not key or not initial:kind='omission' if not key else 'insertion'
                elif len(options[initial])>1 or len(word)>1:kind='phrase'
            choices=(core or {}).get((l,r),{})
            before=choices.get(initial,{})
            after=choices.get(key,{})
            def delta(feature):
                if feature in before and feature in after:return after[feature]-before[feature]
                return None
            supporting=[n for n,vote in zip(mismatch,support) if vote]
            opposing=[n for n,vote in zip(mismatch,against) if vote]
            reliability=min(opposing)-min(supporting) if supporting and opposing else None
            rows.append(dict(left=l,right=r,old=text[l:r],new=word,kind=kind,s=support,b=against,w=whole,rest=reliability,
                             lm=delta('lm'),acoustic=delta('acoustic'),gap=delta('gap')))
    return rows


def eligible(rows, rules):
    edits=[]
    for row in rows:
        rule=rules.get(row['kind'])
        if not rule:continue
        support=row['s']
        if rule['form']=='arabic' and not re.search('[0-9]',row['new']):continue
        if rule['form']=='chinese' and re.search('[0-9]',row['new']):continue
        if sum(support)<rule['votes'] or sum(row['w'])<rule['whole']:continue
        if not all(support[i] for i in rule['witness']):continue
        signal=rule.get('signal')
        if signal and (row[signal[0]] is None or row[signal[0]]<signal[1]):continue
        if sum(support)-sum(row['b'])<rule['lead']:continue
        edits.append(row)
    return edits


def proposals(rows,rules):
    edits=eligible(rows,rules)
    # Never insert incompatible pieces or splice overlapping alternatives.
    chosen=[]
    for c in sorted(edits,key=lambda x:(sum(x['s']),sum(x['w']),-sum(x['b']),x['right']-x['left']),reverse=True):
        if not any(c['left']<s['right'] and c['right']>s['left'] or
                   c['left']==s['left'] or c['right']==s['right'] for s in chosen):
            chosen.append(c)
    return sorted(chosen,key=lambda x:x['left'])


def render(text, fields, edits):
    parts=[dict(left=e['left'],right=e['right'],choices=[{},dict(text=e['new'])]) for e in edits]
    return materialize(text,fields,parts,[1]*len(parts))


def review(text,fields,donors,rules,core,listen):
    primary=collect(text,fields,donors,core)
    optimistic=[dict(c,s=c['s']+[1],b=c['b']+[0],w=c['w']+[1],rest=float('inf')) for c in primary]
    possible=eligible(optimistic,rules)
    if not possible:
        return text,fields
    pessimistic=[dict(c,s=c['s']+[0],b=c['b']+[1],w=c['w']+[0],rest=-float('inf')) for c in primary]
    certain=proposals(pessimistic,rules)
    # When all possible edits are guaranteed and compatible, a sixth read cannot
    # change anything. This also avoids loading another recognizer for most audio.
    if len(possible)==len(certain):
        return render(text,fields,certain)
    extra=listen()
    if not extra:return text,fields
    return render(text,fields,proposals(collect(text,fields,[*donors,extra],core),rules))


def validate_rules(rules):
    kinds={'year','percent','small','classifier','count','round','quantity','number_sequence','pronoun',
           'omission','insertion','phrase','lexical'}
    if not isinstance(rules,dict) or not set(rules)<=kinds:
        raise ValueError('Unsupported word review categories')
    for r in rules.values():
        signal=r.get('signal')
        if (r['form'] not in ('any','arabic','chinese') or not 1<=r['votes']<=6
                or not 0<=r['whole']<=6 or not -6<=r['lead']<=6
                or not all(isinstance(i,int) and 0<=i<6 for i in r['witness'])
                or (signal is not None and (len(signal)!=2 or signal[0] not in ('lm','acoustic','rest')
                    or not isinstance(signal[1],(float,int))))):
            raise ValueError('Invalid word review rule')
    return rules
