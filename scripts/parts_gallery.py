import base64
import hashlib
import io
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
GALLERY = ROOT / "data" / "parts_gallery"
DB = GALLERY / "references.sqlite3"
options = ort.SessionOptions()
options.intra_op_num_threads = 1
session = ort.InferenceSession(str(GALLERY / "mobilenetv2-12.onnx"), options,
                               providers=["CPUExecutionProvider"])


def features(data):
    with Image.open(io.BytesIO(data)) as image:
        if image.width * image.height > 40_000_000:
            raise ValueError("image too large")
        rgb = ImageOps.exif_transpose(image).convert("RGB").resize((224, 224), Image.Resampling.BILINEAR)
    pixels = np.asarray(rgb, dtype=np.float32) / 255
    pixels = (pixels - np.float32([.485, .456, .406])) / np.float32([.229, .224, .225])
    vector = session.run(None, {"input": pixels.transpose(2, 0, 1)[None]})[0][0]
    vector -= vector.mean()
    return vector / max(np.linalg.norm(vector), 1e-8)


def build():
    with tempfile.NamedTemporaryFile(dir=GALLERY, delete=False) as tmp:
        target = Path(tmp.name)
    try:
        conn = sqlite3.connect(target)
        try:
            conn.execute("CREATE TABLE refs (sha TEXT PRIMARY KEY, label TEXT, source TEXT, feature BLOB, jpg BLOB)")
            for folder in ("汽配盲测300", "汽配复测300", "汽配三测300", "汽配四测300"):
                root = ROOT / "results" / folder
                for row in json.loads((root / "manifest.json").read_text(encoding="utf8")):
                    data = (root / "images" / row["image"]).read_bytes()
                    assert hashlib.sha256(data).hexdigest() == row["sha256"]
                    conn.execute("INSERT INTO refs VALUES(?,?,?,?,?)", (
                        row["sha256"], row["label"], row["source"], features(data).tobytes(), data))
            assert conn.execute("SELECT COUNT(*), COUNT(DISTINCT label) FROM refs").fetchone() == (1200, 50)
            conn.commit()
        finally:
            conn.close()
        os.replace(target, DB)
    finally:
        target.unlink(missing_ok=True)


def lookup(data):
    query = features(data)
    conn = sqlite3.connect(DB.as_uri() + "?mode=ro", uri=True)
    try:
        rows = conn.execute("SELECT sha,label,feature FROM refs").fetchall()
        matrix = np.stack([np.frombuffer(row[2], dtype=np.float32) for row in rows])
        scores = matrix @ query
        labels = []
        sheet = Image.new("RGB", (3 * 192, 192), "white")
        for index in np.argsort(-scores):
            sha, label, _ = rows[index]
            if not labels and scores[index] < .55:
                return {"labels": []}
            if label in labels:
                continue
            blob, = conn.execute("SELECT jpg FROM refs WHERE sha=?", (sha,)).fetchone()
            with Image.open(io.BytesIO(blob)) as photo:
                tile = ImageOps.pad(photo.convert("RGB"), (192, 192), color="white")
            sheet.paste(tile, (192 * len(labels), 0))
            labels.append(label)
            if len(labels) == 3:
                break
        buf = io.BytesIO()
        sheet.save(buf, format="JPEG", quality=85)
        return {"labels": labels, "sheet": base64.b64encode(buf.getvalue()).decode("ascii")}
    finally:
        conn.close()


if __name__ == "__main__":
    if sys.argv[1:] == ["--build"]:
        build()
    else:
        print(json.dumps(lookup(sys.stdin.buffer.read())))
