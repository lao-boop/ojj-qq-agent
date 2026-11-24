"""Compare only fully aligned Han-character alternatives against SenseVoice CTC emissions."""
from difflib import SequenceMatcher
from pathlib import Path
import re
import sys
import unicodedata

import numpy as np
import onnxruntime as ort

model_dir = Path(__file__).resolve().parents[1] / "data/models"
sys.path.insert(0, str(model_dir / "selector-runtime"))
import kaldi_native_fbank as knf


def speech_chars(text):
    return "".join(ch for ch in text.casefold() if not ch.isspace() and not unicodedata.category(ch).startswith("P"))


class AcousticRanker:
    def __init__(self):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 2
        opts.inter_op_num_threads = 1
        self.model = ort.InferenceSession(str(model_dir / "sensevoice/model.int8.onnx"), opts,
                                          providers=["CPUExecutionProvider"])
        meta = self.model.get_modelmeta().custom_metadata_map
        self.mean = np.fromstring(meta["neg_mean"], sep=",", dtype=np.float32)
        self.scale = np.fromstring(meta["inv_stddev"], sep=",", dtype=np.float32)
        tokens = (model_dir / "sensevoice/tokens.txt").read_text("utf8").splitlines()
        self.words = {int(i):t for t,i in (line.rsplit(" ",1) for line in tokens)}
        self.ids = {t:i for i,t in self.words.items()}
        self.blank = [0] + [i for i,t in self.words.items() if len(t)==1 and unicodedata.category(t).startswith("P")]
        self.fbank = knf.FbankOptions()
        self.fbank.frame_opts.dither = 0
        self.fbank.frame_opts.window_type = "hamming"
        self.fbank.frame_opts.snip_edges = True
        self.fbank.mel_opts.num_bins = 80
        self.fbank.mel_opts.low_freq = 20
        self.fbank.mel_opts.high_freq = 0

    def logits(self, audio):
        feat = knf.OnlineFbank(self.fbank)
        feat.accept_waveform(16000, (audio*32768).tolist())
        feat.input_finished()
        if not feat.num_frames_ready:
            return None
        frames = np.stack([feat.get_frame(i) for i in range(feat.num_frames_ready)])
        indices = np.arange(0,len(frames),6)[:, None] + np.arange(-3,4)
        x = frames[indices.clip(0,len(frames)-1)].reshape(-1,560)
        args = {"x":((x+self.mean)*self.scale)[None], "x_length":np.array([len(x)],np.int32),
                "language":np.array([3],np.int32), "text_norm":np.array([14],np.int32)}
        return self.model.run(None,args)[0][0,4:]

    def frame_index(self, logits):
        best = logits.argmax(axis=1)
        boundaries = np.flatnonzero(np.r_[True, best[1:] != best[:-1], True])
        chars, frames = [], []
        for start, stop in zip(boundaries[:-1],boundaries[1:]):
            token = self.words[int(best[start])]
            if best[start] == 0 or token.startswith("<"):
                continue
            normalized = speech_chars(token.replace("▁",""))
            chars.append(normalized)
            frames.extend([(start,stop)]*len(normalized))
        return "".join(chars), frames

    def annotate(self, audio, base, segments):
        if not segments:
            return
        logits = self.logits(audio)
        if logits is None:
            return
        greedy, times = self.frame_index(logits)
        token_frames = sorted({a for a,b in times})
        if token_frames:
            top = np.partition(logits[token_frames], -2, axis=1)[:,-2:]
            confidence = float(np.mean(np.clip((top[:,1]-top[:,0])/8,0,1)))
        else:
            confidence = 0.
        clean = speech_chars(base)
        blocks = SequenceMatcher(None, clean, greedy, autojunk=False).get_matching_blocks()
        mapped = {a+i:b+i for a,b,n in blocks for i in range(n)}
        for seg in segments:
            seg["ctc_confidence"] = confidence
            texts = [speech_chars(c["text"]) for c in seg["choices"]]
            if any(not re.fullmatch(r"[\u3400-\u9fff]{0,12}",t) or any(c not in self.ids for c in t) for t in texts):
                continue
            left, right = [len(speech_chars(base[:seg[k]])) for k in ("left","right")]
            if (left and left-1 not in mapped) or (right < len(clean) and right not in mapped):
                continue
            start = times[mapped[left-1]][1] if left else 0
            stop = times[mapped[right]][0] if right < len(clean) else len(logits)
            if stop <= start or stop-start > 120:
                continue
            scores = [self.path_score(logits[start:stop], t) for t in texts]
            if not np.isfinite(scores).all():
                continue
            for c,score in zip(seg["choices"],scores):
                c["acoustic"] = max(-8., float((score-max(scores))/max(1,max(map(len,texts)))))

    def path_score(self, frames, text):
        symbols = [0]
        for ch in text:
            symbols.extend((self.ids[ch],0))
        symbols = np.array(symbols)
        emissions = frames[:,symbols].copy()
        emissions[:,::2] = frames[:,self.blank].max(axis=1)[:,None]
        scores = np.full(len(symbols), -np.inf)
        scores[0] = 0
        skip = np.zeros(len(symbols), bool)
        skip[2:] = (symbols[2:] != symbols[:-2]) & (symbols[2:] != 0)
        for step in emissions:
            next_scores = scores.copy()
            next_scores[1:] = np.logaddexp(next_scores[1:],scores[:-1])
            ids = np.flatnonzero(skip)
            next_scores[ids] = np.logaddexp(next_scores[ids],scores[ids-2])
            scores = next_scores + step
        return np.logaddexp(scores[-1],scores[-2]) if text else scores[0]
