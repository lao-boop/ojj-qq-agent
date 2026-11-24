"""Choose between transcribed spans. No generated text is inserted in the transcript."""
from pathlib import Path
import sys

import numpy as np

models = Path(__file__).resolve().parents[1] / "data/models"
sys.path.insert(0, str(models / "selector-runtime"))
from llama_cpp import Llama


class LanguageJudge:
    def __init__(self):
        model = models / "Qwen2.5-3B-Instruct-GGUF/qwen2.5-3b-instruct-q4_k_m.gguf"
        self.model = Llama(model_path=str(model), n_ctx=512, n_batch=64, n_threads=3,
                           n_threads_batch=3, verbose=False, use_mmap=True)
        self.labels = "ABCD"
        self.ids = [self.model.tokenize(c.encode(), add_bos=False)[0] for c in self.labels]
        self.previous = []

    def _logits(self, prefix, options):
        lines = "\n".join(f"{label}. {text or '（不加字）'}" for label, text in zip(self.labels, options))
        prompt = ("<|im_start|>system\n你是中文语音转写校对员。根据句意、专名、语法和搭配，从候选中选出最可能的原话。"
                  "数字按上下文选择合适的书写方式。只答一个选项字母。<|im_end|>\n"
                  "<|im_start|>user\n" + prefix + "\n哪一项应填入【空缺】？\n" + lines +
                  "<|im_end|>\n<|im_start|>assistant\n")
        ids = self.model.tokenize(prompt.encode(), add_bos=False, special=True)
        same = 0
        for a, b in zip(ids[:-1], self.previous):
            if a != b:
                break
            same += 1
        self.model.n_tokens = same
        self.model.eval(ids[same:])
        self.previous = ids
        logits = self.model._ctx.get_logits()
        return np.array([logits[i] for i in self.ids[:len(options)]])

    def annotate(self, base, segments):
        for seg in segments:
            options = seg["choices"]
            left, right = seg["left"], seg["right"]
            context = base[max(0,left-60):left] + "【空缺】" + base[right:right+60]
            texts = [c["text"] for c in options]
            # Counterbalance position bias; each option appears in two different positions.
            first = self._logits(context, texts)
            rotated = self._logits(context, texts[1:]+texts[:1])
            combined = (first+np.roll(rotated,1))/2
            aligned=np.roll(rotated,1)
            for i,(c, score) in enumerate(zip(options, combined-combined.max())):
                c["judge"] = float(max(score, -8.0))
                c["both_orders"] = bool(i==first.argmax() and i==aligned.argmax())
