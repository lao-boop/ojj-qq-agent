#!/usr/bin/env python3
"""Package committed source only. Private Mac exports are never inputs."""
import argparse, hashlib, io, json, re, subprocess, tarfile, zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
sha=lambda b:hashlib.sha256(b).hexdigest()
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--out',required=True);ap.add_argument('--verification',required=True);a=ap.parse_args()
    out=Path(a.out).resolve()
    if out.exists() or out.with_suffix('.zip').exists():raise SystemExit('Choose a new output directory')
    subprocess.run(['git','diff','--exit-code','HEAD','--'],cwd=ROOT,check=True,stdout=subprocess.DEVNULL)
    commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    branch=subprocess.check_output(['git','branch','--show-current'],cwd=ROOT,text=True).strip()
    verification=json.loads(Path(a.verification).read_text())
    if verification.get('sourceCommit')!=commit:raise SystemExit('Verification source commit mismatch')
    archive=subprocess.check_output(['git','archive','--format=tar',commit],cwd=ROOT)
    records=[];out.mkdir(parents=True)
    def put(rel,b,source,transform='none',original=None):
        if re.search(rb'(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*\n',b):raise ValueError('Credential-like bytes in '+rel)
        f=out/rel;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(b)
        records.append({'path':rel,'sha256':sha(b),'bytes':len(b),'source':source,'source_sha256':sha(original if original is not None else b),'transformation':transform})
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        names=set()
        for member in tar:
            if member.isdir():continue
            if not member.isfile():raise ValueError('Non-regular source entry: '+member.name)
            name=member.name;parts=Path(name).parts
            if name.startswith('/') or '..' in parts or set(parts)&{'.git','node_modules','.venv','__pycache__','tmp','private-transfer'}:raise ValueError('Unexpected source path: '+name)
            if name in {'config.json','.env'} or (name.startswith('data/') and not name.startswith('data/knowledge/')):raise ValueError('Runtime data cannot be publicly packaged: '+name)
            raw=tar.extractfile(member).read();b=raw;transform='none'
            if name.endswith('.cmd'):b=raw.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n');transform='CRLF for Windows batch'
            put('ojj-qq-agent/'+name,b,name,transform,raw);names.add(name)
            if name=='distribution/START_HERE.txt':put('START_HERE.txt',b'\xef\xbb\xbf'+raw,name,'UTF-8 BOM for Notepad',raw)
        required={'setup-windows.cmd','start-windows.cmd','export-private-mac.command','scripts/friend-handover.mjs','scripts/friend-setup.mjs','scripts/friend-check.mjs','docs/WINDOWS-HANDOVER.md','package-lock.json'}
        if not required<=names:raise ValueError('Missing required files: '+str(required-names))
    put('VERIFICATION.json',(json.dumps(verification,ensure_ascii=False,indent=2)+'\n').encode(),'this packaging run')
    manifest={'package':out.name,'date':'2026-11-20','purpose':'Windows takeover of the existing QQ bot; private configuration and history travel separately',
      'source_repository':'https://github.com/lao-boop/ojj-qq-agent','source_commit':commit,'source_branch':branch,
      'contains_private_runtime_data':False,'contains_third_party_installers':False,'native_windows_qq_verified':False,
      'files':records}
    manifestBytes=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode();(out/'MANIFEST.json').write_bytes(manifestBytes)
    checks=[(r['path'],r['sha256']) for r in records]+[('MANIFEST.json',sha(manifestBytes))]
    (out/'SHA256SUMS.txt').write_text(''.join(f'{h}  {p}\n' for p,h in sorted(checks)),encoding='utf8')
    zipPath=out.with_suffix('.zip')
    with zipfile.ZipFile(zipPath,'w',zipfile.ZIP_DEFLATED) as z:
        for f in sorted(out.rglob('*')):
            if f.is_file():z.write(f,out.name+'/'+f.relative_to(out).as_posix())
    with zipfile.ZipFile(zipPath) as z:
        if z.testzip():raise ValueError('Invalid ZIP CRC')
        for p,h in checks:
            if sha(z.read(out.name+'/'+p))!=h:raise ValueError('ZIP payload hash mismatch')
    digest=sha(zipPath.read_bytes());zipPath.with_suffix('.zip.sha256').write_text(f'{digest}  {zipPath.name}\n',encoding='utf8')
    print(json.dumps({'zip':str(zipPath),'bytes':zipPath.stat().st_size,'sha256':digest,'files':len(records)+2,'sourceCommit':commit},ensure_ascii=False))
if __name__=='__main__':main()
