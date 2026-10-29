#!/usr/bin/env python3
import hashlib,json,sys
from pathlib import Path
root=Path(sys.argv[1] if len(sys.argv)>1 else '.').resolve()
m=json.loads((root/'MANIFEST.json').read_text());errors=[]
for item in m['files']:
    f=root/item['delivered']
    if not f.resolve().is_relative_to(root) or not f.is_file():errors.append(item['delivered']);continue
    if hashlib.sha256(f.read_bytes()).hexdigest()!=item['delivered_sha256']:errors.append(item['delivered'])
for line in (root/'SHA256SUMS.txt').read_text().splitlines():
    sha,rel=line.split('  ',1);f=root/rel
    if not f.resolve().is_relative_to(root) or not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest()!=sha:errors.append(rel)
labels=json.loads((root/'tests/badcase_framework/taxonomy.json').read_text())['labels']
for c in json.loads((root/'tests/badcase_framework/cases.json').read_text()):
    if not all(k in c for k in ['id','label','severity','observed','expected','resolution','evidence_refs']) or c['label'] not in labels or c['severity'] not in ['S1','S2','S3']:errors.append(c.get('id','invalid-case'))
    for ref in c['evidence_refs']:
        if not (root/ref.split('#')[0]).is_file():errors.append(ref)
print(json.dumps({'valid':not errors,'payload_files':len(m['files']),'errors':errors},ensure_ascii=False))
sys.exit(bool(errors))
