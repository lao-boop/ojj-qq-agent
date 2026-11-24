"""Independent acoustic replay of the original audio when a proposed term is novel."""
import sys
from pathlib import Path
import subprocess
import numpy as np
from asr_direct import AcousticReader

if __name__ == "__main__":
    ffmpeg = Path(sys.executable).with_name("ffmpeg.exe")
    pcm = subprocess.check_output([str(ffmpeg), "-nostdin", "-v", "error", "-i", sys.argv[1],
                                   "-f", "s16le", "-ar", "16000", "-ac", "1", "-"])
    wave = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
    print(AcousticReader("funasr").read(wave))
