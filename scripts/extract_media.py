"""从 docx/pptx/xlsx 里抽出内嵌图片（这些文件本质是 zip）。

用法：python extract_media.py <文件> <输出目录>
输出：{"ok": true, "images": ["...", ...]}
"""
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from office_content import related, rid, slide_parts, xml

EXTS = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp")

def render_slide(src, outdir, page):
    """Render the whole page, including inherited artwork and native Office shapes."""
    with open(src, 'rb') as source:
        key = hashlib.sha256(source.read()).hexdigest()
    cached = os.path.join(outdir, '%s-p%d-slide.png' % (key,page))
    if os.path.isfile(cached):
        return cached
    with tempfile.TemporaryDirectory(dir=outdir) as work:
        target = os.path.abspath(os.path.join(work,'render.png'))
        script = os.path.join(os.path.dirname(__file__),'render_slide.py')
        subprocess.run([sys.executable,script,
                        os.path.abspath(src),str(page),target],check=True,timeout=20,
                       stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,
                       creationflags=subprocess.CREATE_NO_WINDOW)
        os.replace(target,cached)
    return cached

def readable_preview(data, original):
    from PIL import Image, ImageStat
    with Image.open(io.BytesIO(data)) as source:
        if not ('A' in source.getbands() or 'transparency' in source.info):
            return None
        image = source.convert('RGBA')
        alpha = image.getchannel('A')
        if alpha.getextrema()[0] == 255:
            return None
        average = ImageStat.Stat(image.convert('L'), mask=alpha).mean[0] if alpha.getbbox() else 0
        background = '#39404a' if average > 165 else '#f3f4f6'
        canvas = Image.new('RGB', image.size, background)
        canvas.paste(image, mask=alpha)
        canvas.thumbnail((2400, 2400))
        path = original + '.preview.png'
        with tempfile.NamedTemporaryFile(dir=os.path.dirname(original),suffix='.png',delete=False) as tmp:
            temp_path = tmp.name
        try:
            canvas.save(temp_path, 'PNG')
            os.replace(temp_path, path)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        return path

def main():
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    found = []
    hints = {}
    contexts = {}
    previews = {}
    try:
        with zipfile.ZipFile(src) as z:
            names = z.namelist()
            if src.lower().endswith(".pptx"):
                names = []
                slides = slide_parts(z)
                page = int(sys.argv[3]) if len(sys.argv) > 3 else 0
                for part in (slides[page-1:page] if page else slides):
                    links = related(z, part)
                    slide = xml(z, part)
                    local_text = ' '.join(t.text or '' for t in slide.findall('.//{*}sp//{*}t'))[:500]
                    title = ""
                    for shape in slide.findall(".//{*}sp"):
                        ph = shape.find(".//{*}ph")
                        if ph is not None and ph.get("type") in ("title", "ctrTitle"):
                            title = " ".join(t.text or "" for t in shape.findall(".//{*}t"))[:160]
                            break
                    for picture in slide.findall(".//{*}pic"):
                        desc = picture.find(".//{*}cNvPr")
                        blip = picture.find(".//{*}blip")
                        if blip is not None:
                            key = links.get(rid(blip,"embed"))
                            hints.setdefault(key, {"slideTitle":title,"slideText":local_text,"alt":(desc.get("descr","")[:240] if desc is not None else "")})
                    for blip in slide.findall(".//{*}blip"):
                        name = links.get(rid(blip, "embed"))
                        if name: names.append(name)
            names = [name for name in names if '/media/' in name]
            index = int(sys.argv[4]) if len(sys.argv) > 4 else 0
            if src.lower().endswith('.pptx') and os.name=='nt' and 0 < page <= len(slides) and not index:
                try:
                    full = render_slide(src, outdir, page)
                except Exception as err:
                    print('Slide render unavailable: '+type(err).__name__, file=sys.stderr)
                else:
                    found.append(full)
                    contexts[full] = {'slideTitle':title,'slideText':local_text,'alt':f'附件第{page}页整页渲染，包含本页图片、图表、版式和背景。'}
            for name in (names[index-1:index] if index else dict.fromkeys(names)):
                if "/media/" not in name:
                    continue
                data = z.read(name)
                ext = os.path.splitext(name)[1].lower()
                if os.name == "nt" and ext in (".emf", ".wmf"):
                    from metafile import render
                    with tempfile.TemporaryDirectory(dir=outdir) as work:
                        source = os.path.join(work, "image" + ext)
                        destination = os.path.join(work, "render.png")
                        with open(source, "wb") as vector:
                            vector.write(data)
                        try:
                            render(source, destination)
                            with open(destination, "rb") as rendered:
                                data, ext = rendered.read(), ".png"
                        except OSError:
                            continue
                elif ext not in EXTS or len(data) > 8*1024*1024 or ext == ".bmp":
                    from PIL import Image
                    try:
                        with Image.open(io.BytesIO(data)) as im:
                            im.thumbnail((2400, 2400))
                            buf = io.BytesIO()
                            im.convert("RGB").save(buf, "JPEG", quality=92)
                            data, ext = buf.getvalue(), ".jpg"
                    except (ValueError, OSError):
                        continue
                out = os.path.join(outdir, hashlib.sha1(data).hexdigest()[:10] + ext)
                if not os.path.exists(out):
                    with open(out, "wb") as f:
                        f.write(data)
                found.append(out)
                contexts[out] = hints.get(name,{})
                if ext in ('.png','.webp','.gif'):
                    try:
                        preview = readable_preview(data, out)
                        if preview: previews[out] = preview
                    except (OSError, ValueError):
                        pass
                if len(found) == 6:
                    break
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc), "images": []}))
        return
    print(json.dumps({"ok": True, "images": found, "contexts": contexts, "previews": previews}))


if __name__ == "__main__":
    main()
