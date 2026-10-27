"""从 docx/pptx/xlsx 里抽出内嵌图片（这些文件本质是 zip）。

用法：python extract_media.py <文件> <输出目录>
输出：{"ok": true, "images": ["...", ...]}
"""
import hashlib
import json
import os
import sys
import zipfile

EXTS = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp")


def main():
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    found = []
    try:
        with zipfile.ZipFile(src) as z:
            for name in z.namelist():
                if "/media/" not in name:
                    continue
                if not name.lower().endswith(EXTS):
                    continue
                data = z.read(name)
                if len(data) < 4000:
                    continue
                ext = os.path.splitext(name)[1].lower()
                out = os.path.join(outdir, hashlib.sha1(data).hexdigest()[:10] + ext)
                if not os.path.exists(out):
                    with open(out, "wb") as f:
                        f.write(data)
                found.append(out)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc), "images": []}))
        return
    print(json.dumps({"ok": True, "images": found[:6]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
