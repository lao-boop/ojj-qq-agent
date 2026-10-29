"""Read actual Office output; preserve numbers and page/section counts for review."""
import json, sys
from pathlib import Path

kind, source = sys.argv[1:]
if kind == 'docx':
    from docx import Document
    doc = Document(source)
    result = {'paragraphs': [{'style':p.style.name,'text':p.text} for p in doc.paragraphs if p.text.strip()],
              'tables': [[[c.text for c in r.cells] for r in t.rows] for t in doc.tables]}
elif kind == 'excel':
    from openpyxl import load_workbook
    with open(source,'rb') as stream:
        doc = load_workbook(stream, data_only=False)
        result = {'sheets':[{'name':s.title,'rows':list(s.values),'merged':list(map(str,s.merged_cells.ranges))} for s in doc]}
else:
    from pptx import Presentation
    doc = Presentation(source)
    result = {'pageCount':len(doc.slides),'slides':[{'index':i+1,'texts':[s.text for s in page.shapes if s.has_text_frame],
        'pictures':sum(s.shape_type==13 for s in page.shapes)} for i,page in enumerate(doc.slides)]}
result['bytes'] = Path(source).stat().st_size
print(json.dumps(result,ensure_ascii=False))
