"""把 QQ 语音的 SILK 转成 WAV（用 pilk）。

用法：python silk_to_wav.py <in.silk> <out.wav> [sample_rate]
"""
import sys

import pilk

src, dst = sys.argv[1], sys.argv[2]
rate = int(sys.argv[3]) if len(sys.argv) > 3 else 24000
pilk.silk_to_wav(src, dst, rate)
print("ok", dst)
