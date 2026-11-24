"""Compare business details in independent Mandarin transcripts."""
import re
import json
import unicodedata
from collections import defaultdict
from functools import lru_cache
from decimal import Decimal
from pathlib import Path

from asr_context import number_value
try:
    from jieba.posseg import cut as tag_words
except ImportError:
    tag_words = None

DIGITS = r"[0-9零〇一二两三四五六七八九十百千万亿]+"
NUMBER = rf"[负負+-]?{DIGITS}(?:[.点]{DIGITS})?"
QUANTITY = re.compile(
    rf"(?P<number>{NUMBER})\s*(?P<unit>人民币|块钱|元|块|箱|件|套|台|份|个|盒|张|瓶|包|"
    r"公斤|千克|毫米|厘米|mm|cm|年|月|日|号|点半|点钟|点|时|分钟|分|%)", re.I)
NAME = re.compile(
    r"(?:发给|转给|通知|联系|收件人(?:是|叫)?|负责人(?:是|叫)?|名字(?:是|叫))\s*"
    r"(?P<name>[\u3400-\u9fff]{2,4}?)(?=$|[，。！？、,.:：!?\s]|确认|核对|一下|报价|开会|说|送|发一|提醒)")
ALIASES = {"块钱": "元", "人民币": "元", "块": "元", "号": "日", "点钟": "点",
           "时": "点", "mm": "毫米", "cm": "厘米", "公斤": "千克"}
WEEKDAY = re.compile(r"(?:星期|礼拜|周)([一二三四五六日天1-7])")
IDENTIFIER = re.compile(r"(?:型号|料号|订单号|单号)(?:为|是)?\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{1,19})",re.I)
TASK = re.compile(r"发给|转给|下单|订购|追加|报价|付款|提醒我|收件人|请.{0,5}(?:取消|确认|改期)")


def numeric_key(raw):
    raw = raw.replace("负", "-").replace("負", "-").removeprefix("+").replace("点", ".")
    sign = "-" if raw.startswith("-") else ""
    raw = raw.lstrip("-")
    digits = raw.translate(str.maketrans("零〇一二两三四五六七八九", "001223456789"))
    scaled = re.fullmatch(r"(\d+(?:\.\d+)?)([十百千万亿]?)", digits)
    if scaled:
        factor = {"": 1, "十": 10, "百": 100, "千": 1000, "万": 10000, "亿": 100000000}[scaled[2]]
        return sign + format((Decimal(scaled[1]) * factor).normalize(), "f")
    parts = raw.split(".")
    return sign + ".".join(number_value(p) or p for p in parts)


def fields(text):
    found = defaultdict(list)
    for m in QUANTITY.finditer(text):
        unit = ALIASES.get(m["unit"].lower(), m["unit"])
        label = ("金额" if unit == "元" else "日期" if unit in ("年", "月", "日")
                 else "时间" if unit in ("点", "点半", "分", "分钟") else "数量")
        # Keep different units distinct even when two numerical values match.
        found[label].append((m.span(), m[0], (numeric_key(m["number"]), unit)))
    for m in NAME.finditer(text):
        found["名字"].append((m.span("name"), m["name"], m["name"]))
    for m in WEEKDAY.finditer(text):
        day = m[1].translate(str.maketrans("一二三四五六日天","12345677"))
        found["日期"].append((m.span(), m[0], ("weekday",day)))
    found["日期"].sort()
    for m in IDENTIFIER.finditer(text):
        found["编号"].append((m.span(1),m[1],m[1].casefold()))
    if tag_words is not None:
        offset = 0
        for word, tag in tag_words(text):
            end = offset + len(word)
            if tag == "nr" and 2 <= len(word) <= 5 and all(
                end <= a or offset >= b for (a, b), _, _ in found["名字"]
            ):
                found["名字"].append(((offset, end), word, word))
            offset = end
        found["名字"].sort()
    return found


def business_fields(text, hypotheses):
    selected = fields(text)
    alternatives = [(t, fields(t)) for t in dict.fromkeys(hypotheses) if t != text]
    questions = []
    for label, items in selected.items():
        for index, ((start, end), value, key) in enumerate(items):
            choices = {key: value}
            for other, candidate in alternatives:
                matches = candidate.get(label, [])
                if len(matches) == len(items):
                    (a, b), alt, alt_key = matches[index]
                    # A changed number of words elsewhere must not pair two unrelated people.
                    clean = lambda s: re.sub(r"[\W_]", "", s)
                    before, after = clean(text[:start])[-3:], clean(text[end:])[:3]
                    if ((before and clean(other[:a]).endswith(before)) or
                        (after and clean(other[b:]).startswith(after)) or
                        (not before and not after and not clean(other[:a]+other[b:]))):
                        choices.setdefault(alt_key, alt)
            if len(choices) > 1:
                questions.append(dict(start=start, end=end, label=label, options=list(choices.values())))
    # An expression can occur inside another extracted field. Ask about it once.
    distinct = []
    for q in sorted(questions, key=lambda q: (q["start"], -q["end"])):
        if not distinct or distinct[-1]["end"] <= q["start"]:
            distinct.append(q)
    return distinct


STYLE = str.maketrans({"她":"他", "它":"他", "帳":"账", "帐":"账", "臺":"台"})
WEAK = set("啊呀呢啦么嘛哦呃嗯")
IMPORTANT = re.compile(r"取消|确认|付款|下单|发货|推迟|改期|同意|禁止|拒绝|不要|不能|未|否|不|别")
WORD = re.compile(r"[\u3400-\u9fffA-Za-z0-9]")


def meaning(s):
    s = unicodedata.normalize("NFKC", s).casefold().translate(STYLE)
    s = s.replace("毫米","mm").replace("厘米","cm").replace("千克","kg")
    s = re.sub(r"百分之(" + NUMBER + ")", lambda m: numeric_key(m[1])+"%", s)
    s = re.sub(DIGITS, lambda m: numeric_key(m[0]), s)
    return ''.join(c for c in s if c not in WEAK and not c.isspace() and
                   (c == "%" or not unicodedata.category(c).startswith("P")))


def word_spans(text):
    if tag_words is None:
        return [(m.start(),m.end()) for m in re.finditer(r"[a-zA-Z]+|[\u3400-\u9fff]",text)]
    at = 0
    words = []
    for word, _ in tag_words(text):
        if WORD.search(word):
            words.append((at, at+len(word)))
        at += len(word)
    return words


@lru_cache(maxsize=1024)
def lexical_tags(fragment):
    if not tag_words:
        return set()
    return {tag for word, tag in tag_words(fragment) if len(word)>1}


def term_candidates(text, evidence):
    words = word_spans(text)
    groups = []
    for s in evidence:
        values = {meaning(c["text"]) for c in s["choices"]}
        if len(values) < 2 or values <= {"的","地","得"}:
            continue
        if groups and s["start"] - groups[-1][-1]["end"] <= 2 and s["end"] - groups[-1][0]["start"] <= 8 and (
            not re.search(r"[^\w]", text[groups[-1][-1]["end"]:s["start"]])
        ):
            groups[-1].append(s)
        else:
            groups.append([s])
    for group in groups:
        start, end = group[0]["start"], group[-1]["end"]
        if end-start > 10:
            continue
        hit = [(a,b) for a,b in words if a < end and b > start]
        left = min([start]+[a for a,_ in hit])
        right = max([end]+[b for _,b in hit])
        # Give a single sound or an omitted word a short, speakable context.
        if right-left < 2 or any(not c["text"] for s in group for c in s["choices"]) or (
            right-left <= 2 and any(re.search(DIGITS, c["text"]) for s in group for c in s["choices"])
        ):
            neighbors = [(a,b) for a,b in words if (a==right or b==left) and b-a<=4]
            if neighbors:
                a,b = max(neighbors, key=lambda pair: (pair[1]-pair[0], pair[0]))
                left,right = min(left,a),max(right,b)
        if right-left > 12 or left==right:
            continue
        # Added context must agree across the hypotheses. Otherwise the displayed
        # alternatives would silently combine words from different hypotheses.
        if any(s not in group and s["start"]<right and s["end"]>left for s in evidence):
            continue
        first = text[left:right]
        choices = {meaning(first):first}
        for model in range(3):
            alt = first
            for s in reversed(group):
                c = next(c for c in s["choices"] if c["support"][model])
                a,b = s["start"]-left,s["end"]-left
                alt = alt[:a]+c["text"]+alt[b:]
            if alt.strip() and len(alt)<=14:
                choices.setdefault(meaning(alt),alt)
        if len(choices)<2 or not all(choices):
            continue
        risk = 0.
        for s in group:
            best = s["choices"][0]
            others = [c for c in s["choices"][1:] if meaning(c["text"])!=meaning(best["text"])]
            alt = others[0]
            votes = sum(best["support"][:3])
            conflict = max(0., alt["lm"]-best["lm"], (alt.get("acoustic",0)-best.get("acoustic",0))/2)
            # Names and specialist words may be poorly explained by *all* proposed
            # spellings, even when one candidate wins the reranker by a large margin.
            surprisal = min(6., max(0., -max(c["lm"] for c in s["choices"])-2.0))
            evidence_score = (.9 / (1+alt["gap"]) + .45*(votes==1)
                              + .35*(len(s["choices"])>=3) + .12*min(3.,conflict) + .65*surprisal)
            risk = max(risk,evidence_score)
        tags = [lexical_tags(word) for word in choices.values()]
        proper = {"nr", "nrfg", "nrt", "nz", "ns", "nt", "eng"}
        content = proper | {"n", "v", "vn", "a", "an", "l", "i"}
        if sum(bool(t & proper) for t in tags) >= 2:
            risk += .85
        elif sum(bool(t & content) for t in tags) >= 2:
            risk += .45
        if any(re.search(DIGITS, c["text"]) for s in group for c in s["choices"]):
            risk += .45
        if all(c["text"] in ("", "着", "了", "的", "地", "得", "们") for s in group for c in s["choices"]):
            continue
        if any(IMPORTANT.search(c["text"]) for s in group for c in s["choices"]):
            risk += 1.
        risk += .35 * (len(group)>1) + .25 * any(re.search(r"[A-Za-z]",v) for v in choices.values())
        yield risk, dict(start=left,end=right,label="用词",options=list(choices.values()))


def question_candidates(text, hypotheses, evidence):
    critical = business_fields(text, hypotheses)
    yield from ((3.5 if q["label"]!="名字" else 2.45, q) for q in critical)
    yield from term_candidates(text, evidence)


def ambiguity_signals(text, evidence, priority, q):
    pieces = [s for s in evidence if (s["start"]<q["end"] and s["end"]>q["start"])
              or (s["start"]==s["end"] and q["start"]<=s["start"]<q["end"])]
    picks = [s["choices"][0] for s in pieces]
    runners = [s["choices"][1] for s in pieces]
    # Bounded, content-independent signals. No vocabulary learned from benchmark answers.
    return [1., priority/4, float(q["label"]=="名字"), float(q["label"] not in ("名字","用词")),
            min(1.,len(evidence)/5), min(1.,len(picks)/3), min(1.,len(text)/60),
            max((1/(1+c["gap"]) for c in runners),default=0.),
            max((min(1.,-c["lm"]/6) for c in picks),default=0.),
            max((min(1.,-c.get("acoustic",0)/6) for c in picks),default=0.),
            max((sum(c["support"][:3])==1 for c in picks),default=False),
            max((not c["support"][0] for c in picks),default=False),
            max((not c["support"][1] for c in picks),default=False),
            float(any(re.search("[A-Za-z]",v) for v in q["options"])),
            float(len(q["options"])>=3),
            float(any(not c["text"] for s in pieces for c in s["choices"]))]


@lru_cache(maxsize=1)
def interruption_policy():
    path = Path(__file__).with_name("asr_clarification_policy.json")
    return json.loads(path.read_text("utf8"))


def clarification_fields(text, hypotheses, evidence=None):
    evidence = evidence or []
    policy = interruption_policy()
    ranked = []
    for priority,q in question_candidates(text,hypotheses,evidence):
        signals=ambiguity_signals(text,evidence,priority,q)
        score=sum(w*x for w,x in zip(policy["weights"],signals,strict=True))
        if q["label"] not in ("名字","用词"):
            score += 1
        # A materially different recipient, price or quantity for an actual instruction
        # merits confirmation even if the general interruption score would be low.
        if q["label"]!="用词" and TASK.search(text):
            score=max(score,policy["threshold"]+2)
        if score>=policy["threshold"]:
            ranked.append((score,q))
    if not ranked:
        return []
    return [max(ranked, key=lambda item:item[0])[1]]
