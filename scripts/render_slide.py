"""Export one displayed PowerPoint slide without changing the source presentation."""
import sys
import os
import json
import asyncio
from pathlib import Path
from zipfile import ZipFile
from office_content import slide_parts, xml, paragraph
from win32com.client import dynamic
import win32api
import win32event
from PIL import Image

sys.path.append(str(Path(__file__).resolve().parents[1] / 'data/models/slide-ocr-runtime'))


async def screenshot_text(filename, native_text):
    """Read the pixels independently of the vision model when Windows OCR is available."""
    try:
        from winrt.windows.globalization import Language
        from winrt.windows.graphics.imaging import BitmapDecoder
        from winrt.windows.media.ocr import OcrEngine
        from winrt.windows.storage import StorageFile, FileAccessMode

        tag = 'zh-Hans-CN' if any('\u4e00' <= c <= '\u9fff' for c in native_text) else 'en-US'
        engine = OcrEngine.try_create_from_language(Language(tag)) or OcrEngine.try_create_from_user_profile_languages()
        if engine is None:
            return ''
        source = await StorageFile.get_file_from_path_async(os.path.abspath(filename))
        stream = await source.open_async(FileAccessMode.READ)
        try:
            decoder = await BitmapDecoder.create_async(stream)
            bitmap = await decoder.get_software_bitmap_async()
            try:
                result = await engine.recognize_async(bitmap)
                return '\n'.join(line.text for line in result.lines)
            finally:
                bitmap.close()
        finally:
            stream.close()
    except (ImportError, OSError, RuntimeError) as error:
        print('Windows OCR unavailable: '+type(error).__name__, file=sys.stderr)
        return ''


def detail_views(slide, target, number, width, height, native_text):
    """Give dense screenshots more pixels without including cropped-away or hidden content."""
    rendered = os.path.join(target, 'detail-source-%04d.png' % number)
    slide.Export(rendered, 'PNG', width, height)
    names = []
    try:
        try:
            ocr = asyncio.run(asyncio.wait_for(screenshot_text(rendered,native_text), timeout=15))
        except TimeoutError:
            ocr = ''
        with Image.open(rendered) as image:
            for row in range(2):
                for column in range(2):
                    left = max(0, column * width // 2 - 48)
                    top = max(0, row * height // 2 - 48)
                    box = (left, top, min(width, (column+1)*width//2+48),
                           min(height, (row+1)*height//2+48))
                    tile = image.crop(box)
                    if all(lo == hi for lo, hi in tile.convert('RGB').getextrema()):
                        continue
                    name = 'detail-%04d-%d-%d.png' % (number,row,column)
                    tile.save(os.path.join(target,name))
                    names.append(name)
    finally:
        os.unlink(rendered)
    return names, ocr


def main():
    source, page, target = sys.argv[1:]
    app = dynamic.Dispatch('PowerPoint.Application')
    security = app.AutomationSecurity
    try:
        app.AutomationSecurity = 3
        deck = app.Presentations.Open(source, -1, 0, 0)
        try:
            height = round(1600 * deck.PageSetup.SlideHeight / deck.PageSetup.SlideWidth)
            if page == 'all':
                manifest = []
                with ZipFile(source) as package:
                    parts = slide_parts(package)
                    if len(parts) != deck.Slides.Count:
                        raise ValueError('幻灯片数量不一致')
                    for number, part in enumerate(parts,1):
                        name = 'page-%04d.jpg' % number
                        current = deck.Slides.Item(number)
                        current.Export(os.path.join(target,name),'JPG',1600,height)
                        slide = xml(package,part)
                        text = [paragraph(p) for p in slide.findall('.//{*}p')]
                        native_text = '\n'.join(t for t in text if t.strip())
                        details, ocr = [], ''
                        if slide.find('.//{*}pic') is not None or slide.find('.//{*}chart') is not None:
                            details, ocr = detail_views(current,target,number,2400,round(1.5*height),native_text)
                        manifest.append({'page':number,'image':name,'details':details,
                                         'text':native_text, 'ocr':ocr})
                with open(os.path.join(target,'pages.json'),'w',encoding='utf8') as handle:
                    json.dump(manifest,handle,ensure_ascii=False)
            else:
                deck.Slides.Item(int(page)).Export(target, 'PNG', 1600, height)
        finally:
            deck.Close()
    finally:
        app.AutomationSecurity = security


if __name__ == '__main__':
    mutex = win32event.CreateMutex(None, False, r'Local\XiaojingyuPowerPointRender')
    try:
        acquired = win32event.WaitForSingleObject(mutex, 120000)
        if acquired not in (0, 0x80):
            raise TimeoutError('等待 PowerPoint 渲染超时')
        try:
            main()
        finally:
            win32event.ReleaseMutex(mutex)
    finally:
        win32api.CloseHandle(mutex)
