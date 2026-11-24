"""Focus review images on visible slide content, including artwork inherited from the master."""
import json
import sys
from pathlib import Path
from statistics import median
from zipfile import ZipFile

from PIL import Image, ImageChops
from office_content import related, slide_parts, xml


def diagram_layout(package, slide_part):
    diagrams = []
    for part in dict.fromkeys(related(package,slide_part).values()):
        if not part.startswith('ppt/diagrams/drawing') or not part.endswith('.xml'):
            continue
        tree = xml(package,part).find('.//{*}spTree')
        if tree is None:
            continue
        points = []
        for shape in tree.findall('{*}sp'):
            props = shape.find('{*}spPr')
            if props is None or not any(props.find('{*}'+fill) is not None for fill in
                                        ('solidFill','gradFill','pattFill','blipFill')):
                continue
            geom = props.find('{*}prstGeom')
            pos = props.find('{*}xfrm/{*}off')
            extent = props.find('{*}xfrm/{*}ext')
            if geom is None or pos is None or extent is None:
                continue
            w,h = int(extent.get('cx')),int(extent.get('cy'))
            points.append((int(pos.get('y'))+h/2,int(pos.get('x'))+w/2,h,geom.get('prst')))
        if not points or len(points)>100:
            continue
        tolerance = median(p[2] for p in points)*0.2
        rows = []
        for point in sorted(points):
            if not rows or point[0]-rows[-1][0][0] > tolerance:
                rows.append([])
            rows[-1].append(point)
        xmin = min(p[1] for p in points)
        width = max(1,max(p[1] for p in points)-xmin)
        diagrams.append([[{'shape':p[3],'centerXPercent':round((p[1]-xmin)*100/width)}
                          for p in sorted(row,key=lambda p:p[1])] for row in rows])
    return diagrams


def focus(image):
    image = image.convert('RGB')
    w, h = image.size
    corners = [image.getpixel(p) for p in ((0,0),(w-1,0),(0,h-1),(w-1,h-1))]
    background = max(corners, key=corners.count)
    if corners.count(background) < 3:
        return image
    diff = ImageChops.difference(image, Image.new('RGB', image.size, background))
    channels = diff.split()
    mask = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2])
    bounds = mask.point(lambda value: 255 if value > 12 else 0).getbbox()
    if not bounds:
        return None
    left, top, right, bottom = bounds
    return image.crop((max(0,left-20),max(0,top-20),min(w,right+20),min(h,bottom+20)))


folder = Path(sys.argv[1])
manifest = folder / 'pages.json'
pages = json.loads(manifest.read_text('utf8'))
with ZipFile(sys.argv[2]) as package:
    for page,part in zip(pages,slide_parts(package),strict=True):
        page['diagramLayout'] = diagram_layout(package,part)
for page in pages:
    details = []
    if page['details']:
        for filename in page['details']:
            with Image.open(folder/filename) as tile:
                crop = focus(tile)
                if crop is None or crop.size == tile.size:
                    details.append(filename)
                    continue
                name = 'focus-'+filename
                crop.save(folder/name)
                details.append(name)
    else:
        with Image.open(folder/page['image']) as image:
            w, h = image.size
            for row in range(2):
                for col in range(2):
                    box = (max(0,col*w//2-24),max(0,row*h//2-24),
                           min(w,(col+1)*w//2+24),min(h,(row+1)*h//2+24))
                    crop = focus(image.crop(box))
                    if crop is None or min(crop.size) < 24:
                        continue
                    name = f"focus-{page['page']}-{row}-{col}.png"
                    crop.save(folder/name)
                    details.append(name)
    page['reviewDetails'] = details
updated = folder / 'review-pages.json'
updated.write_text(json.dumps(pages,ensure_ascii=False),encoding='utf8')
updated.replace(manifest)
