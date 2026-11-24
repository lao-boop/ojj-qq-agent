"""Resolve competing acoustic hypotheses using agreement and a local masked-language model."""
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL_DIR = Path(__file__).resolve().parents[1] / "data/models/bert-chinese-rerank"
DIGITS = dict(zip("零一二三四五六七八九", range(10)), 〇=0, 两=2)
POWERS = {"十": 10, "百": 100, "千": 1000, "万": 10000, "亿": 100000000}


def number_value(text):
    """Compare forms of a non-negative integer. Unknown forms receive no format bonus."""
    if re.fullmatch(r"[0-9]+", text):
        return text
    if not text or any(c not in DIGITS and c not in POWERS for c in text):
        return None
    if all(c in DIGITS for c in text):
        return "".join(str(DIGITS[c]) for c in text)
    if sum(c in "万亿" for c in text) > 1:
        return None
    total = section = digit = 0
    for c in text:
        if c in DIGITS:
            digit = DIGITS[c]
        elif POWERS[c] < 10000:
            section += (digit or 1) * POWERS[c]
            digit = 0
        else:
            total += (section + digit) * POWERS[c]
            section = digit = 0
    return str(total + section + digit)


class Surface:
    def __init__(self, text):
        self.text = text
        self.tokens = []
        self.offsets = []
        for m in re.finditer(r"[A-Za-z]+|[0-9]+(?:[.][0-9]+)?|[零〇一二两三四五六七八九十百千万亿]+|.", text, re.S):
            token = unicodedata.normalize("NFKC", m[0]).casefold()
            if not token.strip() or (unicodedata.category(token[0]).startswith("P") and token != "%"):
                continue
            self.tokens.append(token)
            self.offsets.append(m.span())

    def bounds(self, start, stop):
        left = self.offsets[start][0] if start < len(self.tokens) else (self.offsets[-1][1] if self.tokens else 0)
        right = self.offsets[stop-1][1] if stop > start else left
        return left, right

    def surface(self, start, stop):
        left, right = self.bounds(start, stop)
        return self.text[left:right]


def align(source, target):
    matches = SequenceMatcher(None, source, target, autojunk=False).get_matching_blocks()
    return {a+i: b+i for a, b, n in matches for i in range(n)}


def disagreements(surfaces, *, preserve_first_three=True):
    base = surfaces[0]
    alignments = [align(base.tokens, s.tokens) for s in surfaces[1:]]
    shared = set.intersection(*(set(m) for m in alignments))
    anchors = [(i, *(m[i] for m in alignments)) for i in sorted(shared)]
    anchors.append(tuple(len(x.tokens) for x in surfaces))
    prev = (-1,) * len(surfaces)
    for end in anchors:
        start = tuple(i+1 for i in prev)
        prev = end
        if start == end:
            continue
        options = {}
        for i, surface in enumerate(surfaces):
            key = tuple(surface.tokens[start[i]:end[i]])
            if key not in options:
                options[key] = {"text": surface.surface(start[i], end[i]), "support": [0] * len(surfaces)}
            options[key]["support"][i] = 1
        if len(options) > 1 and (not preserve_first_three or not any(all(o["support"][:3]) for o in options.values())):
            yield start[0], end[0], list(options.values())


class ContextSelector:
    def __init__(self):
        self.tokenizer = Tokenizer.from_file(str(MODEL_DIR / "tokenizer.json"))
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 2
        opts.inter_op_num_threads = 1
        self.model = ort.InferenceSession(str(MODEL_DIR / "model_quantized.onnx"), opts,
                                          providers=["CPUExecutionProvider"])
        self.mask = self.tokenizer.token_to_id("[MASK]")

    def likelihood(self, left, choice, right):
        prefix = self.tokenizer.encode(left[-25:], add_special_tokens=False).ids
        suffix = self.tokenizer.encode(right[:25], add_special_tokens=False).ids
        middle = self.tokenizer.encode(choice, add_special_tokens=False).ids
        tokens = [self.tokenizer.token_to_id("[CLS]"), *prefix, *middle, *suffix, self.tokenizer.token_to_id("[SEP]")]
        start = 1+len(prefix)
        stop = start+len(middle)
        # Include the boundaries to detect a missing word or an unnecessary repetition.
        positions = list(range(max(1, start-2), min(len(tokens)-1, stop+2)))
        if not positions:
            return -10.0
        # Bound work for long transcription disagreements.
        if len(positions) > 12:
            positions = [positions[i] for i in np.linspace(0, len(positions)-1, 12, dtype=int)]
        scores = []
        for offset in range(0, len(positions), 4):
            batch = positions[offset:offset+4]
            ids = np.tile(np.array(tokens, np.int64), (len(batch), 1))
            ids[np.arange(len(batch)), batch] = self.mask
            inputs = {"input_ids": ids, "attention_mask": np.ones_like(ids), "token_type_ids": np.zeros_like(ids)}
            logits = self.model.run(None, inputs)[0][np.arange(len(batch)), batch, :].astype(np.float64)
            maximum = logits.max(axis=1)
            log_z = maximum + np.log(np.exp(logits-maximum[:, None]).sum(axis=1))
            scores.extend(logits[np.arange(len(batch)), [tokens[i] for i in batch]]-log_z)
        return float(np.mean(scores))

    def analyze(self, fire, qwen, sense, *extra):
        surfaces = tuple(Surface(t) for t in (fire, qwen, sense, *extra))
        base = surfaces[0]
        segments = []
        for start, end, choices in disagreements(surfaces):
            left, right = base.bounds(start, end)
            values = {number_value(c["text"]) for c in choices}
            for c in choices:
                c["lm"] = self.likelihood(fire[:left], c["text"], fire[right:])
                c["numeric_format"] = int(len(values) == 1 and None not in values
                                          and bool(re.fullmatch(r"[0-9]+", c["text"])))
            segments.append({"left": left, "right": right, "choices": choices})
        return segments

    def transcribe(self, fire, qwen, sense):
        return render(fire, self.analyze(fire, qwen, sense), DEFAULT_POLICY)


# Acoustic-model priors are applied once per disagreement. The LM can only rank
# strings actually emitted at that location by one of the three speech models.
DEFAULT_POLICY = (2.0, 1.0, 0.8, 1.0, 0.0, 0.0)


def render(base, segments, policy):
    fire_weight, qwen_weight, sense_weight, language_weight, numeric_weight, judge_weight = policy
    for piece in reversed(segments):
        def score(option):
            f, q, s = option["support"][:3]
            return (f*fire_weight + q*qwen_weight + s*sense_weight + language_weight*option["lm"]
                    + numeric_weight*option.get("numeric_format", 0) + judge_weight*option.get("judge", 0))
        best = max(piece["choices"], key=score)
        base = base[:piece["left"]] + best["text"] + base[piece["right"]:]
    return base


def rank_features(base, segments, segment, choice):
    """Generic decision signals. No sample identity, speaker, corpus or reference is available."""
    fire, qwen, sense = choice["support"][:3]
    opts = segment["choices"]
    lm = max(-6., choice["lm"] - max(c["lm"] for c in opts))
    is_number = any(c.get("numeric_format") for c in opts)
    latin = bool(re.search(r"[A-Za-z]", choice["text"]))
    code_switch = any(re.search(r"[A-Za-z]", c["text"]) for c in opts)
    # Missing context makes LM judgements about isolated words less reliable.
    neighbors = max(0, len(base)-(segment["right"]-segment["left"]))
    sparse = 12 / (12 + neighbors)
    disputed_chars = sum(max(s["right"]-s["left"],1) for s in segments)
    disputed_share = min(1., disputed_chars / max(len(base), 1))
    confidence = segment.get("ctc_confidence", 0.5) - 0.5
    return [fire, qwen, sense, lm, choice.get("numeric_format", 0),
            choice.get("judge", 0), choice.get("acoustic", 0),
            fire*sparse, fire*disputed_share, qwen*disputed_share, sense*is_number,
            latin, qwen*code_switch, float(not choice["text"]), lm*sparse,
            fire*confidence, sense*confidence, choice["support"][3] if len(choice["support"]) > 3 and not is_number else 0]


def select_ranked(base, segments, weights, evidence=None):
    selected = []
    offset = 0
    for seg in segments:
        def score(c):
            return sum(w*x for w,x in zip(weights,rank_features(base, segments, seg, c),strict=True))
        ranked = sorted(((score(c), c) for c in seg["choices"]), key=lambda item: -item[0])
        top_score, best = ranked[0]
        selected.append(best["text"])
        if evidence is not None:
            start = seg["left"] + offset
            evidence.append({"start": start, "end": start + len(best["text"]),
                             "choices": [dict(c, gap=top_score-s) for s,c in ranked]})
            offset += len(best["text"]) - (seg["right"]-seg["left"])
    for seg, replacement in reversed(list(zip(segments, selected))):
        base = base[:seg["left"]] + replacement + base[seg["right"]:]
    return base


class MandarinWordSelector:
    def __init__(self, policy):
        self.policy = policy
        self.context = ContextSelector()
        self.acoustic = self.judge = None
        if policy["acoustic"]:
            from asr_acoustic_rank import AcousticRanker
            self.acoustic = AcousticRanker()
        if policy["judge"]:
            from asr_language_judge import LanguageJudge
            self.judge = LanguageJudge()

    def select(self, audio, texts, evidence=None):
        base = texts[0]
        segments = self.context.analyze(*texts)
        if self.acoustic:
            self.acoustic.annotate(audio, base, segments)
        if self.judge:
            self.judge.annotate(base, segments)
        return select_ranked(base, segments, self.policy["weights"], evidence)
