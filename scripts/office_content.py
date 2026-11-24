"""Read Office content in document order and resolve precise user lookups."""
import posixpath
import re
from xml.etree import ElementTree as ET
from zipfile import ZipFile


def xml(z, name):
    if z.getinfo(name).file_size > 96 * 1024 * 1024:
        raise ValueError("文档 XML 过大")
    return ET.fromstring(z.read(name))


def related(z, part):
    folder, name = posixpath.split(part)
    path = posixpath.join(folder, "_rels", name + ".rels")
    if path not in z.namelist():
        return {}
    return {r.get("Id"): posixpath.normpath(posixpath.join(folder, r.get("Target"))).lstrip("/")
            for r in xml(z, path) if r.get("Target") and r.get("TargetMode") != "External"}


def rid(node, key="id"):
    return next((v for k, v in node.attrib.items() if k.endswith("}" + key)), None)


def slide_parts(z):
    part = "ppt/presentation.xml"
    links = related(z, part)
    return [links[rid(s)] for s in xml(z, part).findall(".//{*}sldIdLst/{*}sldId") if rid(s) in links]


def paragraph(p):
    return "".join(n.text or "" if n.tag.endswith("}t") else "\t" if n.tag.endswith("}tab") else "\n"
                   for n in p.iter() if n.tag.endswith(("}t", "}tab", "}br", "}cr")))


def cell_request(question):
    question = re.sub(r'(?:工作表|sheet)\s*[「“"][^」”"]+[」”"]', '', question, flags=re.I)
    question = re.sub(r"(?:'[^']+'|[^\s!]+)!(?=\$?[a-zA-Z]+\$?\d)", "", question)
    address = re.search(r'(?<![A-Za-z0-9])\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})(?![A-Za-z0-9])', question)
    if not address or re.search(r'求和|平均|合计|比较|加上|减去|为什么|解释|分析|翻译|公式|格式|颜色|[+*/]|[：:]\s*\$?[A-Za-z]{1,3}\$?\d', question):
        return None
    if len(re.findall(r'(?<![A-Za-z0-9])\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}(?![A-Za-z0-9])',question)) != 1:
        return None
    return "".join(address.groups()).upper()


def word_slides(z, ext, question):
    if ext == ".docx":
        parts = [("正文", "word/document.xml")]
        parts += [(p.split("/")[-1],p) for p in sorted(z.namelist()) if re.fullmatch(r"word/(header\d+|footer\d+|footnotes|endnotes)\.xml",p)]
    else:
        parts = [("第%d页"%i,p) for i,p in enumerate(slide_parts(z),1)]
    blocks, answers = [], []
    quote = re.search(r'「(.+)」|“(.+)”|"(.+)"',question,re.S)
    completion = quote and re.search(r"补出|补全|续写原文|接下来|后面|后半句|余下|剩余|接着写",question)
    prefix = next((g for g in quote.groups() if g is not None),None) if completion else None
    position = re.search(r'paragraph\s+(\d+)|第\s*(\d+)\s*段',question,re.I)
    ordinal = int(next(g for g in position.groups() if g)) if position else None
    page = re.search(r'第\s*(\d+)\s*页',question) if ext==".pptx" else None
    candidates=[]
    for label,part in parts:
        if page and label!="第%s页"%page.group(1): continue
        doc = xml(z,part)
        ps = [paragraph(p) for p in doc.iterfind(".//{*}p") if p.tag.endswith("main}p")]
        for i,raw in enumerate(ps,1):
            s=raw.strip()
            if not s or (ordinal and (ordinal!=i or ext==".docx" and label!="正文")): continue
            if prefix and s.startswith(prefix) and s[len(prefix):].strip():
                answers.append(s[len(prefix):].strip())
                candidates.append(f"{label}第{i}段：{s[:150]}")
            elif prefix and prefix in re.sub(r'[\n\t]', '', s) and re.sub(r'[\n\t]', '', s).startswith(prefix):
                rest=re.sub(r'[\n\t]', '', s)[len(prefix):].strip()
                if rest:
                    answers.append(rest)
                    candidates.append(f"{label}第{i}段：{s[:150]}")
            if not prefix and ordinal and re.search(r'原文|内容|照录',question) and not re.search(r'翻译|分析|解释|总结',question):
                answers.append(s)
        blocks.append(label+"\n"+"\n".join(s for s in ps if s.strip()))
    unique=list(dict.fromkeys(answers))
    if len(unique)>1 and candidates:
        return blocks, '有多个段落符合，请指定页码或段号。\n'+'\n'.join(candidates[:5])
    return blocks, unique[0] if len(unique)==1 else None


def spreadsheet(z, path, question):
    book="xl/workbook.xml"
    links=related(z,book)
    sheets=[(s.get("name"),links[rid(s)]) for s in xml(z,book).findall(".//{*}sheet") if rid(s) in links and "/worksheets/" in links[rid(s)]]
    addr=cell_request(question)
    named=[s for s,_ in sheets if s and (('「'+s+'」') in question or ('“'+s+'”') in question or (s+'!').lower() in question.lower())]
    if not named:
        named=[s for s,_ in sheets if s and s.lower() in question.lower()]
    explicit = re.search(r'(?:工作表|sheet)\s*[「“"]([^」”"]+)[」”"]',question,re.I)
    target = explicit.group(1) if explicit else named[0] if len(named)==1 else sheets[0][0] if len(sheets)==1 and not named else None
    if addr and target:
        try:
            from openpyxl import load_workbook
            wb = load_workbook(path, read_only=True, data_only=True)
            try:
                ws = wb[target]
                ws.reset_dimensions()
                value = ws[addr].value
                if value is not None:
                    return [f"{target}!{addr} = {value}"], str(value)
            finally:
                wb.close()
        except Exception:
            # Some otherwise readable packages have incompatible workbook styles.
            pass
    shared=[]
    if "xl/sharedStrings.xml" in z.namelist():
        shared=["".join(t.text or "" for t in si.findall(".//{*}t")) for si in xml(z,"xl/sharedStrings.xml")]
    blocks=[]
    for name,part in sheets:
        lines=["[工作表 "+name+"]"]
        for c in xml(z,part).iterfind(".//{*}c"):
            ref=c.get("r","")
            val=c.findtext("{*}v","")
            typ=c.get("t")
            if typ=="s" and val: val=shared[int(val)]
            elif typ=="inlineStr": val="".join(t.text or "" for t in c.findall(".//{*}t"))
            elif typ=="b": val={"0":"False","1":"True"}.get(val,val)
            if not val and c.findtext("{*}f"): val="="+c.findtext("{*}f")
            if addr==ref and name==target and val:
                return [name+"!"+ref+" = "+val], val
            if val: lines.append(ref+" = "+val)
        blocks.append("\n".join(lines))
    return blocks,None


def extract(path, ext, question):
    with ZipFile(path) as z:
        if ext in (".xlsx",".xlsm"): blocks,answer=spreadsheet(z,path,question)
        else: blocks,answer=word_slides(z,ext,question)
    text="\n".join(blocks)
    terms=re.findall(r'[A-Za-z0-9_]{2,}|[\u4e00-\u9fff]{2,}',question.lower())
    if question and len(text)>12000:
        chunks=[block[i:i+1500] for block in blocks for i in range(0,len(block),1500)]
        ranked=sorted(range(len(chunks)),key=lambda i:sum(chunks[i].lower().count(t) for t in terms),reverse=True)
        selected=set(ranked[:4])
        selected.update(round(i*(len(chunks)-1)/3) for i in range(4))
        context="\n…\n".join(chunks[i] for i in sorted(selected))
    else: context=text[:20000]
    return {"ok":True,"chars":len(text),"text":context,"answer":answer}
