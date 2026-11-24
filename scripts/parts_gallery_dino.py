import base64
import hashlib
import io
import json
import os
import random
import sqlite3
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'data' / 'parts_gallery'
DB = ASSETS / 'references_dino.sqlite3'
SCENE_DB = ASSETS / 'repair_scenes.sqlite3'
options = ort.SessionOptions()
options.intra_op_num_threads = 2
session = ort.InferenceSession(str(ASSETS / 'dinov2-small-int8.onnx'), options,
                               providers=['CPUExecutionProvider'])


def visual_tokens(image):
    if image.width * image.height > 40_000_000:
        raise ValueError('image too large')
    rgb = ImageOps.exif_transpose(image).convert('RGB').resize((224, 224), Image.Resampling.BICUBIC)
    x = np.asarray(rgb, dtype='float32') / 255
    x = (x - np.float32([.485, .456, .406])) / np.float32([.229, .224, .225])
    return session.run(None, {'pixel_values': x.transpose(2, 0, 1)[None]})[0][0]


def global_feature(tokens):
    # Combine the global class token and pooled local patch features.
    cls, patches = tokens[0], tokens[1:].mean(axis=0)
    return np.concatenate([cls / np.linalg.norm(cls), patches / np.linalg.norm(patches)]) / np.float32(2**.5)


def feature(image):
    return global_feature(visual_tokens(image))


def dhash(image):
    gray = np.asarray(image.convert('L').resize((9, 8), Image.Resampling.LANCZOS))
    return int.from_bytes(np.packbits(gray[:, :-1] > gray[:, 1:]).tobytes(), 'big')


def build(archive_path, excluded_manifests):
    protected = set()
    protected_visual = []
    for file in excluded_manifests:
        for item in json.loads(file.read_text(encoding='utf8')):
            protected.add(item['sha256'])
            with Image.open(file.parent / 'images' / item['image']) as im:
                protected_visual.append(dhash(im))
    with tempfile.NamedTemporaryFile(dir=ASSETS, delete=False) as temp:
        target = Path(temp.name)
    conn = sqlite3.connect(target)
    try:
        conn.execute('CREATE TABLE refs(id INTEGER PRIMARY KEY, label TEXT, sha TEXT UNIQUE, source TEXT, jpg BLOB)')
        conn.execute('CREATE TABLE model(name TEXT PRIMARY KEY, value BLOB)')
        vectors, targets, seen = [], [], set()
        rng = random.Random(526)
        with ZipFile(archive_path) as archive:
            groups = {}
            for name in archive.namelist():
                p = Path(name)
                if p.suffix.lower() == '.jpg' and p.parent.parent.name == 'train':
                    groups.setdefault(p.parent.name, []).append(name)
            labels = sorted(groups)
            assert len(labels) == 50
            for idx, label in enumerate(labels):
                names = sorted(groups[label])
                rng.shuffle(names)
                count = 0
                for name in names:
                    data = archive.read(name)
                    sha = hashlib.sha256(data).hexdigest()
                    if sha in protected or sha in seen:
                        continue
                    with Image.open(io.BytesIO(data)) as im:
                        h = dhash(im)
                        if any((h ^ ref).bit_count() <= 6 for ref in protected_visual):
                            continue
                        vector = feature(im)
                    conn.execute('INSERT INTO refs VALUES(?,?,?,?,?)', (len(vectors), label, sha, name, data))
                    seen.add(sha)
                    vectors.append(vector)
                    targets.append(idx)
                    count += 1
                    if count == 100:
                        break
                print(label, count, flush=True)
        matrix = np.stack(vectors)
        y = np.asarray(targets, dtype=np.int32)
        eye = np.eye(len(labels), dtype=np.float32)
        weights = np.linalg.solve(matrix.T @ matrix + np.eye(matrix.shape[1], dtype=np.float32)*.4,
                                  matrix.T @ eye[y])
        for key, value in [('vectors', matrix.tobytes()), ('targets', y.tobytes()),
                           ('weights', weights.tobytes()), ('labels', json.dumps(labels).encode())]:
            conn.execute('INSERT INTO model VALUES(?,?)', (key, value))
        conn.commit()
        conn.close()
        os.replace(target, DB)
    finally:
        conn.close()
        target.unlink(missing_ok=True)


def read_index(conn):
    raw = dict(conn.execute('SELECT name,value FROM model'))
    labels = json.loads(raw['labels'])
    ids = np.frombuffer(raw['targets'], np.int32)
    vectors = np.frombuffer(raw['vectors'], np.float32).reshape(len(ids), -1)
    weights = np.frombuffer(raw['weights'], np.float32).reshape(-1, len(labels))
    return labels, ids, vectors, weights


def rank(vector, index, cubic_dual=None):
    labels, ids, vectors, weights = index
    sim = vectors @ vector
    class_scores = vector @ weights if cubic_dual is None else (sim**3) @ cubic_dual
    nearest = np.argsort(-sim)
    top_scores = np.array([np.sort(sim[ids == i])[-3:].mean() for i in range(len(labels))])
    order = np.argsort(-(class_scores + .7 * top_scores))
    winner = order[0]
    strong = (np.argmax(class_scores) == winner and ids[nearest[0]] == winner
              and class_scores[winner] - class_scores[order[1]] >= .12 and top_scores[winner] >= .52)
    return order[:3], sim, bool(strong)


def scene_feature(image, full):
    oriented = ImageOps.exif_transpose(image)
    w, h = oriented.size
    center = oriented.crop((w//6, h//6, w-w//6, h-h//6))
    return np.concatenate([full * np.sqrt(np.float32(.75)), feature(center) * np.float32(.5)])


def fit_scene_kernel(vectors, targets, classes):
    # Interactions between scene features distinguish installations sharing a background.
    gram = (vectors @ vectors.T) ** 3
    gram.flat[::len(targets)+1] += .1
    return np.linalg.solve(gram, np.eye(classes, dtype=np.float32)[targets])


def build_scenes(*manifests):
    """Fit one index to the verified reference sets, keeping each original once."""
    annotated = ASSETS / 'repair_targets.json'
    boxes = json.loads(annotated.read_text(encoding='utf8')) if annotated.exists() else {}
    vectors, items = [], []
    seen = {}
    for manifest in manifests:
        for row in json.loads(manifest.read_text(encoding='utf8')):
            jpg = (manifest.parent / 'images' / row['image']).read_bytes()
            sha = hashlib.sha256(jpg).hexdigest()
            if sha != row['sha256']:
                raise ValueError('Development image differs from the manifest')
            if sha in seen:
                if seen[sha] != row['label']:
                    raise ValueError('Conflicting labels for the same reference image')
                continue
            seen[sha] = row['label']
            with Image.open(io.BytesIO(jpg)) as im:
                vectors.append(scene_feature(im, feature(im)))
            items.append((len(items), row['label'], row['guide'], sha, jpg))
    matrix = np.stack(vectors)
    labels = sorted({item[1] for item in items})
    y = np.asarray([labels.index(item[1]) for item in items], dtype=np.int32)
    # Dual ridge fit keeps this small reference collection inexpensive to rebuild.
    weights = matrix.T @ np.linalg.solve(matrix @ matrix.T + .4 * np.eye(len(y), dtype=np.float32),
                                          np.eye(len(labels), dtype=np.float32)[y])
    with tempfile.NamedTemporaryFile(dir=ASSETS, delete=False) as tmp:
        target = Path(tmp.name)
    conn = sqlite3.connect(target)
    try:
        conn.execute('CREATE TABLE refs(id INTEGER PRIMARY KEY,label TEXT,guide TEXT,sha TEXT UNIQUE,jpg BLOB)')
        conn.executemany('INSERT INTO refs VALUES(?,?,?,?,?)', items)
        conn.execute('CREATE TABLE regions(id INTEGER PRIMARY KEY, box TEXT NOT NULL)')
        conn.executemany('INSERT INTO regions VALUES(?,?)',
                         [(i, json.dumps(boxes[sha])) for i, _, _, sha, _ in items if sha in boxes])
        rear_file = ASSETS / 'repair_lamp_backs.json'
        if rear_file.is_file():
            rear_hashes = set(json.loads(rear_file.read_text(encoding='utf8')))
            conn.execute('CREATE TABLE lamp_backs(id INTEGER PRIMARY KEY)')
            conn.executemany('INSERT INTO lamp_backs VALUES(?)',
                             [(i,) for i, _, _, sha, _ in items if sha in rear_hashes])
        build_focus(conn)
        conn.execute('CREATE TABLE model(name TEXT PRIMARY KEY,value BLOB)')
        conn.executemany('INSERT INTO model VALUES(?,?)', [
            ('vectors', matrix.tobytes()), ('targets', y.tobytes()),
            ('weights', weights.tobytes()), ('labels', json.dumps(labels).encode()),
            ('cubic_dual', fit_scene_kernel(matrix, y, len(labels)).tobytes())])
        fit_pair_models(conn)
        conn.commit()
        conn.close()
        os.replace(target, SCENE_DB)
    finally:
        conn.close()
        target.unlink(missing_ok=True)


LAMP_ASSEMBLIES = ('HEADLIGHTS', 'TAILLIGHTS', 'HIGH MOUNT STOP LAMP')
FOCUS_CLASSES = (*LAMP_ASSEMBLIES, 'IGNITION COIL', 'OIL FILTER', 'BRAKE PAD', 'BRAKE CALIPER')


def patch_grid(tokens):
    patches = tokens[1:]
    side = round(len(patches)**.5)
    return patches.reshape(side, side, -1)


def region_vector(grid, box):
    side = grid.shape[0]
    x1, y1, x2, y2 = np.asarray(box) * side / 100
    region = grid[int(y1):max(int(y1)+1, int(np.ceil(y2))), int(x1):max(int(x1)+1, int(np.ceil(x2)))]
    vector = region.mean(axis=(0, 1))
    return vector / max(float(np.linalg.norm(vector)), 1e-8)


def build_focus(conn):
    conn.execute('CREATE TABLE IF NOT EXISTS focus_regions(id INTEGER PRIMARY KEY, vector BLOB NOT NULL)')
    rows = conn.execute('SELECT r.id, r.label, r.jpg, b.box FROM refs r JOIN regions b ON r.id=b.id')
    samples = []
    for idx, label, jpg, box in rows:
        if label not in FOCUS_CLASSES:
            continue
        with Image.open(io.BytesIO(jpg)) as im:
            vector = region_vector(patch_grid(visual_tokens(im)), json.loads(box))
        samples.append((idx, vector.astype(np.float32).tobytes()))
    conn.execute('DELETE FROM focus_regions')
    conn.executemany('INSERT INTO focus_regions VALUES(?,?)', samples)


def focus_neighbors(conn, tokens, scene_label):
    if tokens is None or scene_label not in FOCUS_CLASSES:
        return {}, None, {}
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='focus_regions'").fetchone():
        return {}, None, {}
    brakes = scene_label in ('BRAKE PAD', 'BRAKE CALIPER')
    rows = [(i, l, g, v) for i, l, g, v in conn.execute(
        'SELECT f.id, r.label, r.guide, f.vector FROM focus_regions f JOIN refs r ON r.id=f.id')
            if (l in ('BRAKE PAD','BRAKE CALIPER')) == brakes]
    if not rows:
        return {}, None, {}
    grid = patch_grid(tokens)
    windows = [(20,20,80,80), (32,32,68,68)]
    for y in (0,30,60):
        for x in (0,30,60):
            windows.append((x,y,x+40,y+40))
    if brakes:
        # A mounted pad can occupy a narrow strip on either face of the rotor.
        for x in (10, 30, 50, 70):
            for y in (10, 32, 54):
                windows.extend([(x,y,x+18,y+42), (y,x,y+42,x+18)])
    query = np.stack([region_vector(grid, w) for w in windows])
    refs = np.stack([np.frombuffer(v, dtype=np.float32) for _, _, _, v in rows])
    per_window = refs @ query.T
    scores = per_window.max(axis=1)
    by_guide = {}
    similarities = {}
    for (idx, label, guide, _), score in zip(rows, scores):
        similarities[idx] = float(score)
        examples = by_guide.setdefault(label, {})
        examples[guide] = max(examples.get(guide, -1), float(score))
    ranked = sorted(((np.mean(sorted(ex.values(),reverse=True)[:3]), label)
                     for label, ex in by_guide.items() if len(ex)>=3), reverse=True)
    # Require agreement across different jobs before surfacing a local hypothesis.
    choice = ranked[0][1] if len(ranked)>1 and ranked[0][0]-ranked[1][0]>.025 else None
    names = PAIR_LABELS['brakes' if brakes else 'lamps']
    support = []
    for label in names:
        grouped = {}
        for (_,category,guide,_), values in zip(rows,per_window):
            if category == label:
                grouped[guide] = np.maximum(grouped.get(guide,-1), values)
        if len(grouped)<3:
            return similarities, choice, {}
        support.append(np.sort(np.stack(list(grouped.values())),axis=0)[-3:].mean(axis=0))
    boxes = {}
    for index,label in enumerate(names):
        # Use common appearance across jobs and separation from the adjacent object.
        score = support[index] - .55 * support[1-index]
        boxes[label] = windows[int(score.argmax())]
    return similarities, choice, boxes


def query_details(image, boxes):
    if not boxes:
        return None
    original = ImageOps.exif_transpose(image).convert('RGB')
    sheet = Image.new('RGB', (960,252), 'white')
    context = ImageOps.contain(original, (316,228))
    draw = ImageDraw.Draw(context)
    colors = ('#10a675', '#e99c13')
    for i, box in enumerate(boxes.values()):
        bounds = tuple(round(v*original.size[k%2]/100) for k,v in enumerate(box))
        locator = tuple(round(v*context.size[k%2]/100) for k,v in enumerate(box))
        draw.rectangle(locator, outline=colors[i], width=2)
        tile = ImageOps.contain(original.crop(bounds), (316,228))
        offset = (i+1)*320
        sheet.paste(tile,(offset+(320-tile.width)//2,(228-tile.height)//2))
        ImageDraw.Draw(sheet).rectangle((offset+2,230,offset+317,237),fill=colors[i])
    sheet.paste(context,((320-context.width)//2,(228-context.height)//2))
    stream=io.BytesIO()
    sheet.save(stream, 'JPEG',quality=87)
    return base64.b64encode(stream.getvalue()).decode('ascii')


CONFUSABLE = {'BRAKE PAD': 'BRAKE CALIPER', 'BRAKE CALIPER': 'BRAKE PAD',
              'FUSE BOX': 'BATTERY', 'BATTERY': 'FUSE BOX',
              'HEADLIGHTS': 'TAILLIGHTS', 'TAILLIGHTS': 'HEADLIGHTS', 'IGNITION COIL': 'HEADLIGHTS',
              'HIGH MOUNT STOP LAMP': 'TAILLIGHTS', 'OIL FILTER': 'OIL PAN', 'OIL PAN': 'OIL FILTER'}


def comparison_sheet(conn, labels, ids, sim, winner, local=None, focus=None):
    local = local or {}
    other = CONFUSABLE.get(labels[winner])
    if other not in labels or not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='regions'").fetchone():
        return None
    regions = dict(conn.execute('SELECT id,box FROM regions'))
    lamps = {*LAMP_ASSEMBLIES, 'IGNITION COIL'}
    lamp_comparison = labels[winner] in lamps
    detail = lamp_comparison or labels[winner] in {'BRAKE PAD','BRAKE CALIPER','FUSE BOX','BATTERY'}
    pair = sorted((labels[winner], other))
    if lamp_comparison or (labels[winner] == 'OIL FILTER' and focus in lamps):
        detail = True
        group = LAMP_ASSEMBLIES if labels[winner] in LAMP_ASSEMBLIES and LAMP_ASSEMBLIES[2] in labels else ('HEADLIGHTS','TAILLIGHTS','IGNITION COIL','OIL FILTER')
        pair = [name for name in group if name in labels]
    backs = set()
    if 'FUSE BOX' in pair and conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='lamp_backs'").fetchone():
        backs = {i for i, in conn.execute('SELECT id FROM lamp_backs') if i in regions}
        if backs:
            lamp = max(backs, key=lambda i:sim[i])
            pair.append(labels[ids[lamp]])
    sheet = Image.new('RGB', (320*len(pair), 394 if detail else 244), 'white')
    for pos, name in enumerate(pair):
        cls = labels.index(name)
        pool = backs if backs and name in ('HEADLIGHTS','TAILLIGHTS') else regions
        candidates = [i for i in pool if ids[i] == cls]
        if not candidates:
            return None
        nearest = max(candidates, key=lambda i: .55*sim[i]+.45*local.get(i,sim[i]))
        jpg, = conn.execute('SELECT jpg FROM refs WHERE id=?', (nearest,)).fetchone()
        with Image.open(io.BytesIO(jpg)) as im:
            tile = ImageOps.contain(ImageOps.exif_transpose(im).convert('RGB'), (318, 240))
        x1,y1,x2,y2 = json.loads(regions[nearest])
        box = (tile.width*x1/100, tile.height*y1/100, tile.width*x2/100, tile.height*y2/100)
        if detail:
            # Preserve the marked context above a close view of the object itself.
            x1, y1, x2, y2 = box
            margin = max(3, round(.15 * max(x2-x1,y2-y1)))
            patch = tile.crop((max(0,int(x1)-margin), max(0,int(y1)-margin),
                               min(tile.width,int(x2)+margin), min(tile.height,int(y2)+margin)))
            zoom = ImageOps.contain(patch,(316,146))
            sheet.paste(zoom,(pos*320+(320-zoom.width)//2,246+(146-zoom.height)//2))
        ImageDraw.Draw(tile).rectangle(box, outline='#00e7be', width=2)
        sheet.paste(tile,(pos*320+(320-tile.width)//2,(244-tile.height)//2))
    buffer = io.BytesIO()
    sheet.save(buffer,'JPEG',quality=86)
    # Adjacent frames from one repair job should count as one supporting example.
    guides = dict(conn.execute('SELECT id,guide FROM refs'))
    seen_guides = set()
    votes = 0
    for idx in np.argsort(-sim):
        if guides[idx] in seen_guides:
            continue
        seen_guides.add(guides[idx])
        votes += int(ids[idx] == winner)
        if len(seen_guides) == 5:
            break
    return {'labels': pair, 'detail': detail, 'focus': focus, 'votes': votes, 'jobs': len(seen_guides),
            'jpg': base64.b64encode(buffer.getvalue()).decode('ascii')}


PAIR_LABELS = {'brakes': ('BRAKE PAD', 'BRAKE CALIPER'), 'lamps': ('HEADLIGHTS', 'TAILLIGHTS'),
               'rear_lamps': ('TAILLIGHTS', 'HIGH MOUNT STOP LAMP'),
               'rear_sockets': ('TAILLIGHTS', 'HIGH MOUNT STOP LAMP')}


def fit_pair_models(conn):
    """Fit verified pairs and estimate margins with complete tutorials held out."""
    labels, ids, matrix, _ = read_index(conn)
    guides = dict(conn.execute('SELECT id,guide FROM refs'))
    rear = {i for i, in conn.execute('SELECT id FROM lamp_backs')} if conn.execute(
        "SELECT 1 FROM sqlite_master WHERE name='lamp_backs'").fetchone() else set()
    conn.execute('CREATE TABLE IF NOT EXISTS pair_models(name TEXT PRIMARY KEY, ids BLOB, alpha BLOB, margins TEXT)')
    for name, pair in PAIR_LABELS.items():
        subset = np.array([i for i,c in enumerate(ids) if labels[c] in pair and
                           (name not in ('lamps','rear_sockets') or i in rear)], dtype=np.int32)
        target = np.array([1. if labels[ids[i]]==pair[0] else -1. for i in subset], dtype=np.float32)
        if min(sum(target>0),sum(target<0)) < 12:
            continue
        kernel = (matrix[subset] @ matrix[subset].T)**3
        fold = np.array([int(hashlib.sha256(guides[i].encode()).hexdigest()[:8],16)%5 for i in subset])
        regularized = kernel.copy()
        penalty = .35
        if name in ('rear_lamps','rear_sockets'):
            # Give rare centre lamps a comparable contribution to the kernel fit.
            penalty = .35 * np.where(target > 0, (target > 0).mean(), (target < 0).mean()) * 2
        regularized.flat[::len(subset)+1] += penalty
        held_out = np.zeros(len(subset), dtype=np.float32)
        for k in range(5):
            train = fold!=k
            alpha = np.linalg.solve(regularized[np.ix_(train, train)], target[train])
            held_out[~train] = kernel[np.ix_(~train,train)] @ alpha
        margins = []
        for sign in (1.,-1.):
            cutoff = 10.
            for threshold in (.15,.25,.35,.45,.55,.65,.75):
                confident = sign*held_out >= threshold
                if confident.sum()>=12 and (target[confident]==sign).mean()>=.88:
                    cutoff=threshold
                    break
            margins.append(cutoff)
        alpha = np.linalg.solve(regularized,target)
        conn.execute('INSERT OR REPLACE INTO pair_models VALUES(?,?,?,?)',
                     (name,subset.tobytes(),alpha.tobytes(),json.dumps(margins)))


def pair_evidence(conn, labels, ids, sim, name):
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='pair_models'").fetchone():
        return None
    row = conn.execute('SELECT ids,alpha,margins FROM pair_models WHERE name=?',(name,)).fetchone()
    if row is None:
        return None
    subset = np.frombuffer(row[0],np.int32)
    score = float(sim[subset]**3 @ np.frombuffer(row[1],np.float32))
    pair = PAIR_LABELS[name]
    side = 0 if score>=0 else 1
    calibrated = abs(score)>=json.loads(row[2])[side]
    examples = []
    for label in pair:
        indices = subset[ids[subset]==labels.index(label)]
        best = int(indices[sim[indices].argmax()])
        jpg, = conn.execute('SELECT jpg FROM refs WHERE id=?',(best,)).fetchone()
        with Image.open(io.BytesIO(jpg)) as im:
            examples.append(ImageOps.contain(ImageOps.exif_transpose(im).convert('RGB'),(310,225)))
    sheet = Image.new('RGB',(624,228),'white')
    for i,im in enumerate(examples):
        sheet.paste(im,(312*i+(312-im.width)//2,(228-im.height)//2))
    data=io.BytesIO()
    sheet.save(data,'JPEG',quality=84)
    return {'labels':pair,'preferred':pair[side] if calibrated else None,
            'jpg':base64.b64encode(data.getvalue()).decode('ascii')}


def scene_reference(image, vector, tokens=None):
    if not SCENE_DB.is_file():
        return None
    conn = sqlite3.connect(SCENE_DB.as_uri() + '?mode=ro', uri=True)
    try:
        index = read_index(conn)
        labels, ids, vectors, _ = index
        if vectors.shape[1] == 2 * len(vector):
            vector = scene_feature(image, vector)
        kernel = conn.execute("SELECT value FROM model WHERE name='cubic_dual'").fetchone()
        dual = np.frombuffer(kernel[0],np.float32).reshape(len(ids),len(labels)) if kernel else None
        order, sim, strong = rank(vector, index, dual)
        cls = order[0]
        matches = np.flatnonzero(ids == cls)
        best = int(matches[sim[matches].argmax()])
        pair_supported = CONFUSABLE.get(labels[cls]) == labels[order[1]]
        threshold = .60 if strong else (.64 if pair_supported else .70)
        name = 'brakes' if labels[cls] in PAIR_LABELS['brakes'] else 'lamps'
        expert = pair_evidence(conn,labels,ids,sim,name) if labels[cls] in FOCUS_CLASSES else None
        if expert and labels[cls] in LAMP_ASSEMBLIES and LAMP_ASSEMBLIES[2] in labels:
            socket_match = conn.execute('SELECT 1 FROM lamp_backs WHERE id=?', (best,)).fetchone()
            rear = pair_evidence(conn,labels,ids,sim,'rear_sockets') if socket_match else None
            expert['rearComparison'] = rear or pair_evidence(conn,labels,ids,sim,'rear_lamps')
        local, focus, boxes = focus_neighbors(conn, tokens, labels[cls])
        if expert and boxes:
            expert['queryDetail'] = query_details(image, boxes)
        if sim[best] < threshold:
            return {'label':labels[cls], 'strong':False, 'expertOnly':True, 'expert':expert} if expert else None
        if focus and focus != labels[cls]:
            strong = False
        jpg, = conn.execute('SELECT jpg FROM refs WHERE id=?', (best,)).fetchone()
        with Image.open(io.BytesIO(jpg)) as im:
            preview = ImageOps.contain(im.convert('RGB'), (360, 300))
        buffer = io.BytesIO()
        preview.save(buffer, 'JPEG', quality=85)
        return {'label': labels[cls], 'strong': strong, 'jpg': base64.b64encode(buffer.getvalue()).decode('ascii'),
                'expert': expert, 'comparison': comparison_sheet(conn, labels, ids, sim, cls, local, focus)}
    finally:
        conn.close()


def lookup(data):
    conn = sqlite3.connect(DB.as_uri() + '?mode=ro', uri=True)
    try:
        index = read_index(conn)
        labels, ids, _, _ = index
        with Image.open(io.BytesIO(data)) as im:
            tokens = visual_tokens(im)
            vector = global_feature(tokens)
            order, sim, strong = rank(vector, index)
            scene = scene_reference(im, vector, tokens)
        if sim.max() < .48:
            return {'labels': [], 'scene': scene}
        sheet = Image.new('RGB', (576, 192), 'white')
        for pos, cls in enumerate(order):
            candidates = np.flatnonzero(ids == cls)
            best = int(candidates[sim[candidates].argmax()])
            blob, = conn.execute('SELECT jpg FROM refs WHERE id=?', (best,)).fetchone()
            with Image.open(io.BytesIO(blob)) as im:
                sheet.paste(ImageOps.pad(im.convert('RGB'), (192,192), color='white'), (192*pos,0))
        out = io.BytesIO()
        sheet.save(out, 'JPEG', quality=85)
        return {'labels': [labels[i] for i in order], 'strong': strong, 'scene': scene,
                'sheet': base64.b64encode(out.getvalue()).decode('ascii')}
    finally:
        conn.close()


if __name__ == '__main__':
    if sys.argv[1:2] == ['--build']:
        build(Path(sys.argv[2]), [Path(p) for p in sys.argv[3:]])
    elif sys.argv[1:2] == ['--build-scenes']:
        build_scenes(*(Path(p) for p in sys.argv[2:]))
    else:
        print(json.dumps(lookup(sys.stdin.buffer.read())))
