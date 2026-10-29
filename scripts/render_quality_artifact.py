"""Render real Office files with LibreOffice; inspect PDF text and page bounds."""
import json
import sys
import subprocess
import tempfile
from pathlib import Path
import pymupdf
from PIL import Image, ImageDraw

source, target = map(lambda s: Path(s).resolve(), sys.argv[1:3])
target.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='office-render-') as profile:
    subprocess.run(['soffice', '-env:UserInstallation=' + Path(profile).as_uri(), '--headless', '--convert-to', 'pdf', '--outdir', str(target), str(source)], check=True, capture_output=True, text=True, timeout=90)
pdf = target / (source.stem + '.pdf')
doc = pymupdf.open(pdf)
pages = []
thumbs = []
for i, page in enumerate(doc):
    text = page.get_text()
    violations = []
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            for span in line['spans']:
                x0, y0, x1, y1 = span['bbox']
                if span['text'].strip() and (x0 < -1 or y0 < -1 or x1 > page.rect.width + 1 or y1 > page.rect.height + 1):
                    violations.append(span['text'])
    image = target / f'page-{i+1}.png'
    page.get_pixmap(matrix=pymupdf.Matrix(1.25, 1.25), alpha=False).save(image)
    thumb = Image.open(image).convert('RGB')
    thumb.thumbnail((440, 440))
    tile = Image.new('RGB', (460, 475), '#e9eef5')
    tile.paste(thumb, ((460-thumb.width)//2, 25))
    ImageDraw.Draw(tile).text((12, 8), f'Page {i+1}', fill='black')
    thumbs.append(tile)
    pages.append({'page':i+1,'width':page.rect.width,'height':page.rect.height,'text':text,'blank':not text.strip(),'outOfBoundsText':violations,'image':image.name})
cols = min(3, max(1, len(thumbs)))
contact = Image.new('RGB', (460*cols, 475*((len(thumbs)+cols-1)//cols)), 'white')
for i, tile in enumerate(thumbs):
    contact.paste(tile, ((i%cols)*460, (i//cols)*475))
contact.save(target/'contact.png')
report={'renderer':'LibreOffice PDF + PyMuPDF; thumbnails visually reviewed separately','pdf':pdf.name,'contactSheet':'contact.png','pageCount':len(pages),'pages':pages,'blankPages':[p['page'] for p in pages if p['blank']],'overflowPages':[p['page'] for p in pages if p['outOfBoundsText']]}
(target/'render.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False))
