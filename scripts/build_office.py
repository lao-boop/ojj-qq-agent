"""根据 JSON 规格生成 PPTX / DOCX。

用法：python build_office.py <spec.json>

spec:
{
  "kind": "pptx" | "docx",
  "theme": "history" | "business" | "fresh",
  "title": "...", "subtitle": "...", "author": "...",
  "slides": [{"title": "...", "bullets": ["..."], "image": "C:/...jpg", "notes": "..."}],
  "sections": [{"heading": "...", "paragraphs": ["..."], "bullets": ["..."]}]
}
"""
import json
import os
import sys
import ast
import math
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import date

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

from docx import Document
from docx.shared import Pt as DocPt, RGBColor as DocRGB, Inches as DocInches
from docx.enum.text import WD_ALIGN_PARAGRAPH

from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION

from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, PieChart, Reference
from openpyxl.styles import Font as XFont, PatternFill, Alignment as XAlign, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.utils.cell import range_boundaries
from openpyxl.workbook.properties import CalcProperties

FONT = os.environ.get("OFFICE_FONT") or ("PingFang SC" if sys.platform == "darwin" else "Microsoft YaHei" if sys.platform == "win32" else "Noto Sans CJK SC")

THEMES = {
    "history": {"bg": "F7F2E8", "fg": "2B2118", "accent": "8C2B2B", "muted": "8A7B66"},
    "business": {"bg": "FFFFFF", "fg": "1A2433", "accent": "1F4E79", "muted": "6B7A8C"},
    "fresh": {"bg": "F6FBFA", "fg": "1F2D2C", "accent": "1F8A8A", "muted": "6E8583"},
}


def rgb(hex_str):
    return RGBColor.from_string(hex_str)


def set_run(run, size, color, bold=False, font=FONT):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.name = font
    run.font.color.rgb = rgb(color)
    # 中文字体
    rpr = run._r.get_or_add_rPr()
    ea = rpr.find("{http://schemas.openxmlformats.org/drawingml/2006/main}ea")
    if ea is None:
        from lxml import etree

        ea = etree.SubElement(rpr, "{http://schemas.openxmlformats.org/drawingml/2006/main}ea")
    ea.set("typeface", font)


def add_bg(slide, prs, color):
    rect = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
    rect.fill.solid()
    rect.fill.fore_color.rgb = rgb(color)
    rect.line.fill.background()
    rect.shadow.inherit = False
    slide.shapes._spTree.remove(rect._element)
    slide.shapes._spTree.insert(2, rect._element)


def textbox(slide, left, top, width, height):
    box = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    tf = box.text_frame
    tf.word_wrap = True
    return tf


def build_pptx(spec, out_path):
    theme = THEMES.get(spec.get('theme', 'business'), THEMES['business'])
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    blank = prs.slide_layouts[6]
    accent, ink, muted = theme['accent'], theme['fg'], theme['muted']
    palette = [accent, '2A9D8F', 'E9A23B']

    def shape(slide, x, y, w, h, color, rounded=False):
        obj = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if rounded else MSO_SHAPE.RECTANGLE,
            Inches(x), Inches(y), Inches(w), Inches(h))
        obj.fill.solid(); obj.fill.fore_color.rgb = rgb(color); obj.line.fill.background()
        obj.shadow.inherit = False
        effect = obj._element.find('.//{http://schemas.openxmlformats.org/drawingml/2006/main}effectRef')
        if effect is not None: effect.set('idx', '0')
        if rounded: obj.adjustments[0] = 0.08
        return obj

    def label(slide, x, y, w, h, value, size=20, color=None, bold=False, minimum=14, center=False):
        value = str(value or '')
        # Conservative CJK-aware wrapping estimate: fit text rather than overflow fixed boxes.
        units = lambda line: sum(1 if ord(c) > 127 else .55 for c in line)
        while size > minimum:
            capacity = max(1, (w-.16)*72/size)
            lines = sum(max(1, math.ceil(units(line)/capacity)) for line in value.split('\n'))
            if lines * size * 1.28 <= max(1, (h-.08)*72): break
            size -= 1
        tf = textbox(slide, x, y, w, h)
        tf.margin_left = tf.margin_right = Inches(.06)
        tf.margin_top = tf.margin_bottom = Inches(.02)
        for i, line in enumerate(value.split('\n')):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.line_spacing = 1.15
            p.space_after = Pt(4)
            if center: p.alignment = PP_ALIGN.CENTER
            run = p.add_run(); run.text = line
            set_run(run, size, color or ink, bold)
        return tf

    def bullet_box(slide, values, x, y, w, h, size=21):
        return label(slide, x, y, w, h, '\n'.join('•  '+str(v) for v in values), size=size, minimum=16)

    def notes(slide, item):
        source = str(item.get('source') or '')
        details = str(item.get('notes') or '')
        slide.notes_slide.notes_text_frame.text = details + ('\n\n数据/材料原文：\n'+source if source else '')

    slide = prs.slides.add_slide(blank)
    add_bg(slide, prs, '12243A')
    shape(slide, .8, .8, .75, .09, '52C7B8')
    label(slide, .8, 1.12, 10.9, .5, '小鲸鱼 · 演示文稿', 14, 'A8BED3')
    label(slide, .8, 2.05, 11.55, 2.15, spec.get('title', '演示文稿'), 40, 'FFFFFF', True, minimum=28)
    label(slide, .8, 4.5, 10.9, 1.05, spec.get('subtitle', ''), 22, 'D0DEEB', minimum=18)
    label(slide, .8, 6.62, 10.5, .35, f"{spec.get('author', '小鲸鱼')}  /  {date.today():%Y.%m.%d}", 11, 'A8BED3', minimum=11)
    total = len(spec.get('slides', [])) + 2

    for index, item in enumerate(spec.get('slides', []), 2):
        slide = prs.slides.add_slide(blank)
        add_bg(slide, prs, theme['bg'])
        shape(slide, .65, .32, .55, .07, accent)
        label(slide, .65, .54, 12.0, .94, item.get('title', ''), 29, ink, True, minimum=23)
        top = 1.86
        if item.get('takeaway'):
            shape(slide, .65, 1.58, 12.0, .68, 'EAF1F6', True)
            label(slide, .83, 1.67, 11.64, .5, item['takeaway'], 18, accent, minimum=16)
            top = 2.55
        height = 6.5 - top
        layout = item.get('layout') or ('cards' if item.get('cards') else 'chart' if item.get('chart') else 'image' if item.get('image') else 'bullets')
        bullets = item.get('bullets') or []

        if layout == 'cards':
            cards = item.get('cards') or []
            count = max(1, len(cards)); gap = .23; width = (12.0-gap*(count-1))/count
            for i, card in enumerate(cards):
                x = .65+i*(width+gap)
                shape(slide, x, top, width, height, 'F0F4F8', True)
                label(slide, x+.18, top+.2, width-.36, .38, f'{i+1:02d}', 16, accent, True)
                label(slide, x+.18, top+.83, width-.36, .82, card.get('title', ''), 22, ink, True, minimum=17)
                label(slide, x+.18, top+1.83, width-.36, height-2.05, card.get('text', ''), 19, minimum=16)
        elif layout == 'comparison':
            for i, column in enumerate(item.get('comparison') or []):
                x = .65 + i*6.15
                shape(slide, x, top, 5.85, height, 'F0F4F8', True)
                shape(slide, x, top, 5.85, .7, palette[i])
                label(slide, x+.2, top+.12, 5.45, .5, column.get('title', ''), 22, 'FFFFFF', True, minimum=18)
                bullet_box(slide, column.get('bullets') or [], x+.2, top+1.0, 5.45, height-1.2, 20)
        elif layout == 'timeline':
            steps = item.get('steps') or []; count=max(1,len(steps)); width=12.0/count
            shape(slide, 1.0, top+.48, 11.0, .035, 'CCD7E2')
            for i, step in enumerate(steps):
                x=.65+i*width
                shape(slide, x+.12, top+.2, .58, .58, accent, True)
                label(slide, x+.14, top+.27, .54, .35, str(i+1), 17, 'FFFFFF', True, minimum=17, center=True)
                label(slide, x+.1, top+1.05, width-.2, .85, step.get('title',''), 21, ink, True, minimum=17)
                label(slide, x+.1, top+2.05, width-.2, height-2.2, step.get('text',''), 18, minimum=15)
        elif layout == 'table':
            data=item['table']; columns=data['columns']; rows=data['rows']
            table=slide.shapes.add_table(len(rows)+1,len(columns),Inches(.65),Inches(top),Inches(12),Inches(height)).table
            for i, values in enumerate([columns]+rows):
                for j, value in enumerate(values):
                    cell=table.cell(i,j); cell.text=str(value)
                    cell.fill.solid(); cell.fill.fore_color.rgb=rgb(accent if i==0 else ('F0F4F8' if i%2 else 'FFFFFF'))
                    cell.margin_left=cell.margin_right=Inches(.12)
                    for p in cell.text_frame.paragraphs:
                        p.space_after=Pt(0)
                        for run in p.runs: set_run(run, 16 if i==0 else 15, 'FFFFFF' if i==0 else ink, i==0)
        elif layout == 'chart':
            chart=item['chart']; cdata=CategoryChartData(); cdata.categories=chart['categories']
            for series in chart['series']:
                if len(series['values']) != len(chart['categories']): raise ValueError('图表分类与数值长度不一致')
                cdata.add_series(series['name'],series['values'])
            ctype={'bar':XL_CHART_TYPE.COLUMN_CLUSTERED,'line':XL_CHART_TYPE.LINE_MARKERS,'pie':XL_CHART_TYPE.PIE}[chart['type']]
            # Charts always have their own region; body text cannot extend underneath them.
            if bullets:
                bullet_box(slide,bullets,.65,top,3.55,height,20)
                x,w=4.6,8.05
            else: x,w=.85,11.6
            chart_obj=slide.shapes.add_chart(ctype,Inches(x),Inches(top),Inches(w),Inches(height),cdata).chart
            chart_obj.has_legend=len(chart['series'])>1 or chart['type']=='pie'
            if chart_obj.has_legend:
                chart_obj.legend.position=XL_LEGEND_POSITION.BOTTOM
                chart_obj.legend.include_in_layout=False
            for i, series in enumerate(chart_obj.series):
                series.format.fill.solid(); series.format.fill.fore_color.rgb=rgb(palette[i%len(palette)])
                series.format.line.color.rgb=rgb(palette[i%len(palette)])
            chart_obj.plots[0].has_data_labels=True
            chart_obj.plots[0].data_labels.font.size=Pt(12)
            chart_obj.plots[0].data_labels.font.color.rgb=rgb(ink)
            if chart.get('title'):
                chart_obj.has_title=True; chart_obj.chart_title.text_frame.text=chart['title']
                for p in chart_obj.chart_title.text_frame.paragraphs:
                    for run in p.runs: set_run(run,16,ink,True)
        elif layout == 'image' and item.get('image') and os.path.exists(item['image']):
            bullet_box(slide,bullets,.65,top,6.0,height,22)
            pic=slide.shapes.add_picture(item['image'],Inches(7.05),Inches(top),width=Inches(5.6))
            if pic.height>Inches(height):
                ratio=pic.width/pic.height; pic.height=Inches(height); pic.width=int(pic.height*ratio)
            pic.left=Inches(7.05)+(Inches(5.6)-pic.width)//2
            pic.top=Inches(top)+(Inches(height)-pic.height)//2
        else:
            # A failed/disabled optional image leaves a complete, readable text page.
            if len(bullets)<=3:
                gap=.2; h=(height-gap*max(0,len(bullets)-1))/max(1,len(bullets))
                for i, value in enumerate(bullets):
                    y=top+i*(h+gap)
                    shape(slide,.65,y,12,h,'F0F4F8',True)
                    label(slide,.85,y+.16,.5,.4,f'{i+1:02d}',15,accent,True)
                    label(slide,1.6,y+.15,10.75,h-.3,value,23,minimum=18)
            else: bullet_box(slide,bullets,.85,top,11.5,height,24)
        shape(slide,.65,6.91,12,.012,'D5DEE7')
        label(slide,.65,7.04,10.8,.23,'数据依据见演讲者备注' if item.get('source') else str(spec.get('title','')),10,muted,minimum=10)
        label(slide,11.8,7.02,.8,.28,f'{index:02d} / {total:02d}',10,muted,minimum=10)
        notes(slide,item)

    slide=prs.slides.add_slide(blank); add_bg(slide,prs,'12243A')
    shape(slide,.85,1.35,.75,.09,'52C7B8')
    label(slide,.85,1.85,11.5,1.0,'下一步行动',36,'FFFFFF',True,minimum=28)
    label(slide,.85,3.15,11.3,2.35,spec.get('closing') or '围绕以上方案确认下一步行动与负责人。',27,'D0DEEB',minimum=20)
    label(slide,.85,6.7,11.0,.35,f'{total:02d} / {total:02d}',11,'A8BED3',minimum=11)
    prs.save(out_path)
    return out_path


def _width(text):
    s = str(text or "")
    return sum(2 if ord(ch) > 127 else 1 for ch in s)


def cache_xlsx_formulas(wb, out_path, strict=False):
    """Cache common local calculations for mobile previews; keep formulas for editing.

    Unknown formulas stay untouched and are recalculated by the spreadsheet app.
    Never execute Python code, external links or arbitrary Excel functions.
    """
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    cached = {}
    for index, ws in enumerate(wb.worksheets, 1):
        values, active = {}, set()
        def cell_value(address):
            address = address.replace("$", "")
            if address in values:
                return values[address]
            if address in active:
                raise ValueError("circular formula")
            active.add(address)
            try:
                value = ws[address].value
                if isinstance(value, str) and value.startswith("="):
                    expression = re.sub(r"\$?[A-Z]{1,3}\$?[1-9][0-9]*(?::\$?[A-Z]{1,3}\$?[1-9][0-9]*)?",
                        lambda m: ('R' if ':' in m[0] else 'C') + '(' + repr(m[0]) + ')', value[1:].upper())
                    value = evaluate(ast.parse(expression, mode="eval").body)
                values[address] = value
                return value
            finally:
                active.discard(address)
        def number(value):
            if value is None:
                return 0
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError("not a finite number")
            return value
        def evaluate(node):
            if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
                return number(node.value)
            if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
                value = number(evaluate(node.operand))
                return -value if isinstance(node.op, ast.USub) else value
            if isinstance(node, ast.BinOp):
                a, b = number(evaluate(node.left)), number(evaluate(node.right))
                if isinstance(node.op, ast.Add): return a + b
                if isinstance(node.op, ast.Sub): return a - b
                if isinstance(node.op, ast.Mult): return a * b
                if isinstance(node.op, ast.Div): return a / b
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
                name = node.func.id
                if name in ("C", "R") and len(node.args) == 1 and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                    address = node.args[0].value.replace("$", "")
                    if name == "C": return cell_value(address)
                    a, b, c, d = range_boundaries(address)
                    if (c-a+1)*(d-b+1) > 10000: raise ValueError("range too large")
                    return [cell_value(f"{get_column_letter(col)}{row}") for row in range(b, d+1) for col in range(a, c+1)]
                items = []
                for argument in node.args:
                    value = evaluate(argument)
                    items.extend(value if isinstance(value, list) else [value])
                nums = [number(x) for x in items if isinstance(x, (int, float))]
                if name == "SUM": return sum(nums)
                if name == "COUNT": return len(nums)
                if name == "AVERAGE" and nums: return sum(nums)/len(nums)
                if name == "MIN" and nums: return min(nums)
                if name == "MAX" and nums: return max(nums)
            raise ValueError("unsupported preview formula")
        for row in ws:
            for cell in row:
                if cell.data_type == 'f':
                    try:
                        cached[(index, cell.coordinate)] = number(cell_value(cell.coordinate))
                    except (ValueError, TypeError, SyntaxError, ZeroDivisionError, RecursionError, OverflowError, KeyError) as error:
                        if strict:
                            raise ValueError(f"公式校验失败 {ws.title}!{cell.coordinate}: {error}") from error
    temp = out_path + '.cached'
    with zipfile.ZipFile(out_path) as source, zipfile.ZipFile(temp, 'w', zipfile.ZIP_DEFLATED) as target:
        for info in source.infolist():
            data = source.read(info.filename)
            match = re.fullmatch(r'xl/worksheets/sheet(\d+)\.xml', info.filename)
            if match:
                index = int(match[1])
                root = ET.fromstring(data)
                for cell in root.iter(f'{{{ns}}}c'):
                    key = (index, cell.attrib['r'])
                    if key in cached:
                        value = cell.find(f'{{{ns}}}v')
                        if value is None: value = ET.SubElement(cell, f'{{{ns}}}v')
                        value.text = str(cached[key])
                data = ET.tostring(root, encoding='utf-8', xml_declaration=True)
            target.writestr(info, data)
    os.replace(temp, out_path)


def build_xlsx(spec, out_path):
    theme = THEMES.get(spec.get("theme", "business"), THEMES["business"])
    wb = Workbook()
    wb.calculation = CalcProperties(calcId=0, fullCalcOnLoad=True, forceFullCalc=True, calcMode="auto")
    wb.remove(wb.active)
    thin = Side(style="thin", color="D9D9D9")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    for sh in (spec.get("sheets") or []):
        name = str(sh.get("name") or "Sheet1")[:31]
        ws = wb.create_sheet(title=name)
        ws.sheet_view.showGridLines = False
        cols = [str(c) for c in (sh.get("columns") or [])]
        row = 1
        if spec.get("title"):
            span = max(1, len(cols))
            ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=span)
            cell = ws.cell(row=1, column=1, value=str(spec["title"])[:60] + ("（示例数据）" if sh.get("example") else ""))
            cell.font = XFont(name=FONT, size=18, bold=True, color=theme["accent"])
            cell.fill = PatternFill("solid", fgColor="EAF1F8")
            cell.alignment = XAlign(horizontal="center", vertical="center")
            ws.row_dimensions[1].height = 36
            row = 2

        for j, c in enumerate(cols, 1):
            cell = ws.cell(row=row, column=j, value=c)
            # Dark text remains readable in mobile previews that omit cell fills.
            cell.font = XFont(name=FONT, size=11, bold=True, color="17365D")
            cell.fill = PatternFill("solid", fgColor="DCE6F1")
            cell.alignment = XAlign(horizontal="center", vertical="center")
            cell.border = border
        ws.row_dimensions[row].height = 28

        for i, data_row in enumerate(sh.get("rows") or [], row + 1):
            total = bool(data_row) and str(data_row[0]).strip() in ("合计", "总计", "总金额", "总预算")
            ws.row_dimensions[i].height = 26
            for j, v in enumerate(data_row, 1):
                cell = ws.cell(row=i, column=j, value=v)
                numeric = isinstance(v, (int, float)) or (isinstance(v, str) and v.startswith("="))
                cell.font = XFont(name=FONT, size=11, bold=total, color="17365D" if total else "263445")
                cell.alignment = XAlign(horizontal="right" if numeric else "left", vertical="center", wrap_text=True)
                cell.fill = PatternFill("solid", fgColor="DCE6F1" if total else ("F3F6FA" if i % 2 else "FFFFFF"))
                header = cols[j-1] if j <= len(cols) else ""
                if numeric and any(word in header for word in ("单价", "金额", "预算", "费用", "价格")):
                    cell.number_format = '#,##0.00'
                formats = {'integer': '#,##0', 'number': '#,##0.##', 'currency': '#,##0.00', 'percent': '0.0%', 'date': 'yyyy-mm-dd', 'text': '@'}
                types = sh.get('columnTypes') or []
                if j <= len(types) and types[j-1] in formats:
                    cell.number_format = formats[types[j-1]]
                cell.border = border

        for j in range(1, max(1, len(cols)) + 1):
            longest = _width(cols[j - 1] if j <= len(cols) else "")
            for i in range(row + 1, ws.max_row + 1):
                value = ws.cell(row=i, column=j).value
                if not (isinstance(value, str) and value.startswith("=")):
                    longest = max(longest, _width(value))
            ws.column_dimensions[get_column_letter(j)].width = min(44, max(16, longest + 5))

        for i in range(row + 1, ws.max_row + 1):
            lines = 1
            for j in range(1, len(cols) + 1):
                value = ws.cell(i, j).value
                if isinstance(value, str) and not value.startswith('='):
                    width = ws.column_dimensions[get_column_letter(j)].width - 3
                    lines = max(lines, sum(max(1, math.ceil(_width(line)/width)) for line in value.split('\n')))
            ws.row_dimensions[i].height = min(140, max(26, lines * 17 + 8))

        ws.freeze_panes = ws.cell(row=row + 1, column=1)
        last_data_row = ws.max_row
        if str(ws.cell(last_data_row, 1).value).strip() in ("合计", "总计", "总金额", "总预算"):
            last_data_row -= 1
        ws.auto_filter.ref = f"A{row}:{get_column_letter(max(1, len(cols)))}{max(row, last_data_row)}"
        ws.print_options.horizontalCentered = True
        ws.sheet_properties.pageSetUpPr.fitToPage = True
        ws.page_setup.orientation = "landscape" if len(cols) > 5 else "portrait"
        ws.page_setup.paperSize = ws.PAPERSIZE_A4
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 0
        ws.print_title_rows = f"1:{row}"
        ws.print_area = ws.dimensions
        chart_spec = sh.get('chart')
        if chart_spec and last_data_row > row:
            chart = {'bar': BarChart, 'line': LineChart, 'pie': PieChart}[chart_spec['type']]()
            chart.title = chart_spec.get('title') or str(spec.get('title', '数据概览'))
            chart.style = 10
            for column in chart_spec['values']:
                chart.add_data(Reference(ws, min_col=column, min_row=row, max_row=last_data_row), titles_from_data=True)
            chart.set_categories(Reference(ws, min_col=chart_spec['category'], min_row=row+1, max_row=last_data_row))
            chart.width, chart.height = 20, 10
            anchor_row = ws.max_row + 3
            ws.add_chart(chart, f'A{anchor_row}')
            ws.print_area = f'A1:{get_column_letter(max(len(cols), 6))}{anchor_row+21}'

    if not wb.sheetnames:
        wb.create_sheet(title="Sheet1")
    wb.save(out_path)
    cache_xlsx_formulas(wb, out_path, strict=spec.get("strictFormulas", False))
    return out_path


def build_docx(spec, out_path):
    theme = THEMES.get(spec.get("theme", "business"), THEMES["business"])
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = FONT
    style.font.size = DocPt(11)
    style.paragraph_format.line_spacing = 1.5

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = title.add_run(spec.get("title", "未命名文档"))
    r.font.size = DocPt(24)
    r.font.bold = True
    r.font.name = FONT

    if spec.get("subtitle"):
        sub = doc.add_paragraph()
        sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
        rs = sub.add_run(spec["subtitle"])
        rs.font.size = DocPt(12)
        rs.font.name = FONT
        rs.font.color.rgb = DocRGB.from_string(theme["muted"])

    meta = doc.add_paragraph()
    meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
    rm = meta.add_run(f"{spec.get('author', '小鲸鱼')} · {date.today().strftime('%Y-%m-%d')}")
    rm.font.size = DocPt(10)
    rm.font.name = FONT
    rm.font.color.rgb = DocRGB.from_string(theme["muted"])

    for sec in spec.get("sections", []):
        h = doc.add_heading(sec.get("heading", ""), level=1)
        for run in h.runs:
            run.font.name = FONT
            run.font.color.rgb = DocRGB.from_string(theme["accent"])
        for para in sec.get("paragraphs", []) or []:
            p = doc.add_paragraph(str(para))
            p.paragraph_format.first_line_indent = DocInches(0.3)
        for b in sec.get("bullets", []) or []:
            doc.add_paragraph(str(b), style="List Bullet")

    doc.save(out_path)
    return out_path


def main():
    if len(sys.argv) < 2:
        print("usage: build_office.py spec.json")
        sys.exit(2)
    with open(sys.argv[1], "r", encoding="utf-8-sig") as f:
        spec = json.load(f)
    out = spec.get("out")
    if not out:
        raise SystemExit("spec.out is required")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    kind = spec.get("kind", "pptx")
    if kind == "docx":
        build_docx(spec, out)
    elif kind == "xlsx":
        build_xlsx(spec, out)
    else:
        build_pptx(spec, out)
    print(json.dumps({"ok": True, "out": out}))


if __name__ == "__main__":
    main()
