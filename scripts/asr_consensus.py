"""Select a complete ASR hypothesis by its agreement with two independent decoders."""
import unicodedata
from difflib import SequenceMatcher


def comparable(text):
    return "".join(ch for ch in unicodedata.normalize("NFKC", text).casefold()
                   if not ch.isspace() and not unicodedata.category(ch).startswith("P"))


def character_distance(left, right):
    previous = list(range(len(right) + 1))
    for i, char in enumerate(left, 1):
        row = [i]
        for j, other in enumerate(right, 1):
            row.append(min(previous[j] + 1, row[-1] + 1, previous[j - 1] + (char != other)))
        previous = row
    return previous[-1]


def choose_transcript(*hypotheses):
    # Keep punctuation and spelling from a real decoder. The first decoder breaks ties.
    choices = [(text, comparable(text)) for text in hypotheses if text.strip()]
    if not choices:
        return ""
    scores = [0.0] * len(choices)
    for i, (_, left) in enumerate(choices):
        for j in range(i):
            right = choices[j][1]
            disagreement = character_distance(left, right) / max(len(left), len(right), 1)
            scores[i] += disagreement
            scores[j] += disagreement
    return choices[min(range(len(choices)), key=scores.__getitem__)][0]


def _edits(base, alternative):
    matcher = SequenceMatcher(None, base, alternative, autojunk=False)
    return {(start, stop, alternative[a:b])
            for tag, start, stop, a, b in matcher.get_opcodes() if tag != "equal"}


def vote_spans(primary, second, third):
    """Keep the first decoder's layout; change a span only if two decoders agree."""
    if not all(text.strip() for text in (primary, second, third)):
        return choose_transcript(primary, second, third)
    base_chars, offsets = [], []
    for position, character in enumerate(primary):
        normalized = comparable(character)
        base_chars.extend(normalized)
        offsets.extend([position] * len(normalized))
    if not offsets:
        return primary
    base = "".join(base_chars)
    agreed = _edits(base, comparable(second)) & _edits(base, comparable(third))
    result = primary
    for start, stop, replacement in sorted(agreed, reverse=True):
        left = offsets[start] if start < len(offsets) else offsets[-1] + 1
        right = offsets[stop - 1] + 1 if stop > start else left
        # A normalized ligature can expand into multiple characters.
        if (start and start < len(offsets) and offsets[start-1] == offsets[start]) or (
            stop and stop < len(offsets) and offsets[stop-1] == offsets[stop]
        ):
            continue
        # Retain original formatting of Latin words and codes.
        if any(c.isascii() and c.isalpha() for c in base[start:stop] + replacement):
            continue
        result = result[:left] + replacement + result[right:]
    return result
