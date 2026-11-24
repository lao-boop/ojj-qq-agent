"""Rank only the supplied disputed spellings within the current utterance."""
import json
import sys
from asr_language_judge import LanguageJudge

def choose(text, fields):
    judge = LanguageJudge()
    masked = None
    try:
        selected = []
        for q in fields:
            options = q['options']
            segment = dict(left=q['start'], right=q['end'], choices=[dict(text=t) for t in options])
            judge.annotate(text, [segment])
            first, second, *_ = sorted(segment['choices'], key=lambda c:-c['judge'])
            strong = first['both_orders'] and first['judge'] - second['judge'] >= 4
            if strong and first['text'] != options[0] and q.get('crossCheck'):
                if masked is None:
                    from asr_context import ContextSelector
                    masked = ContextSelector()
                left, right = text[:q['start']], text[q['end']:]
                scores = {word: masked.likelihood(left, word, right) for word in options}
                strong = scores[first['text']] >= max(v for w,v in scores.items() if w != first['text']) + 0.35
            selected.append(first['text'] if strong else options[0])
        return selected
    finally:
        judge.model.close()

if __name__ == '__main__':
    request=json.load(sys.stdin)
    print(json.dumps(choose(request['text'],request['fields']),ensure_ascii=False))
