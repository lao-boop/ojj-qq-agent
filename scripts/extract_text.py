import sys
import json
import os

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ASCII = True  # JSON 里中文用 \\uXXXX 转义，避免 Windows 控制台编码问题


def emit(obj):
    print(json.dumps(obj, ensure_ascii=ASCII))


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "missing path"})
        return
    p = sys.argv[1]
    ext = os.path.splitext(p)[1].lower()
    text = ""
    try:
        if ext in (".docx", ".pptx", ".xlsx", ".xlsm"):
            from office_content import extract
            emit(extract(p, ext, sys.argv[2] if len(sys.argv) > 2 else ""))
            return
        elif ext == ".pdf":
            from pypdf import PdfReader
            reader = PdfReader(p)
            chunks = []
            for i, page in enumerate(reader.pages, 1):
                chunks.append("第%d页: %s" % (i, page.extract_text() or ""))
            text = "\n".join(chunks)
        elif ext in (".txt", ".md", ".csv", ".json", ".log", ".py", ".js", ".ts", ".html", ".xml", ".yml", ".yaml"):
            raw = open(p, "rb").read()
            for enc in ("utf-8", "gbk", "utf-16"):
                try:
                    text = raw.decode(enc)
                    break
                except Exception:
                    continue
        elif ext in (".doc", ".xls", ".ppt"):
            emit({"ok": False, "error": "旧版 Office 格式（.doc/.xls/.ppt）不支持，请另存为 docx/xlsx/pptx"})
            return
        else:
            emit({"ok": False, "error": "不支持的格式 %s" % ext})
            return

        text = text.strip()
        emit({"ok": True, "chars": len(text), "text": text[:20000]})
    except Exception as e:
        emit({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
