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
from openpyxl.styles import Font as XFont, PatternFill, Alignment as XAlign, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.utils.cell import range_boundaries
from openpyxl.workbook.properties import CalcProperties

FONT = "微软雅黑"

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
    theme = THEMES.get(spec.get("theme", "history"), THEMES["history"])
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]
    today = date.today().strftime("%Y.%m.%d")
    total = len(spec.get("slides", []))

    # 封面
    slide = prs.slides.add_slide(blank)
    add_bg(slide, prs, theme["bg"])
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.9), Inches(2.5), Inches(0.18), Inches(2.1))
    bar.fill.solid()
    bar.fill.fore_color.rgb = rgb(theme["accent"])
    bar.line.fill.background()
    tf = textbox(slide, 1.3, 2.35, 10.5, 1.6)
    p = tf.paragraphs[0]
    set_run(p.add_run(), 5, theme["accent"], True)  # 占位，避免空段
    p.runs[0].text = ""
    p = tf.paragraphs[0]
    r = p.add_run()
    r.text = spec.get("title", "未命名")
    set_run(r, 40, theme["fg"], True)
    tf2 = textbox(slide, 1.3, 3.55, 10.5, 0.9)
    p2 = tf2.paragraphs[0]
    r2 = p2.add_run()
    r2.text = spec.get("subtitle", "")
    set_run(r2, 18, theme["muted"])
    tf3 = textbox(slide, 1.3, 5.9, 8.0, 0.5)
    p3 = tf3.paragraphs[0]
    r3 = p3.add_run()
    r3.text = f"{spec.get('author', '小鲸鱼')}  ·  {today}"
    set_run(r3, 12, theme["muted"])

    # 正文
    for idx, s in enumerate(spec.get("slides", []), start=1):
        slide = prs.slides.add_slide(blank)
        add_bg(slide, prs, theme["bg"])
        # 顶部细条
        top_bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, Inches(0.08))
        top_bar.fill.solid()
        top_bar.fill.fore_color.rgb = rgb(theme["accent"])
        top_bar.line.fill.background()

        has_img = bool(s.get("image") and os.path.exists(s["image"]))
        chart = s.get("chart") or None
        cards = s.get("cards") or []

        # 卡片版式：一页三到四张「图标 + 标题 + 一句话」
        if cards:
            tf = textbox(slide, 0.9, 0.75, 11.5, 1.0)
            p = tf.paragraphs[0]
            r = p.add_run()
            r.text = s.get("title", "")
            set_run(r, 28, theme["fg"], True)
            n = min(len(cards), 4)
            gap = 0.3
            card_w = (12.0 - gap * (n - 1)) / n
            for ci, c in enumerate(cards[:n]):
                x = 0.75 + ci * (card_w + gap)
                box = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(2.15), Inches(card_w), Inches(3.9))
                box.fill.solid()
                box.fill.fore_color.rgb = rgb("FFFFFF")
                box.line.color.rgb = rgb(theme["accent"])
                box.line.width = Pt(1.2)
                box.shadow.inherit = False
                icon = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(x + card_w / 2 - 0.42), Inches(2.5), Inches(0.84), Inches(0.84))
                icon.fill.solid()
                icon.fill.fore_color.rgb = rgb(theme["accent"])
                icon.line.fill.background()
                itf = icon.text_frame
                itf.word_wrap = False
                ip = itf.paragraphs[0]
                ip.alignment = PP_ALIGN.CENTER
                ir = ip.add_run()
                icon_text = str(c.get("icon", "◆"))
                if not icon_text or any(ord(ch) > 0xFFFF for ch in icon_text):
                    icon_text = "◆"
                ir.text = icon_text
                set_run(ir, 22, "FFFFFF", True)

                ttf = textbox(slide, x + 0.15, 3.5, card_w - 0.3, 0.5)
                tp = ttf.paragraphs[0]
                tp.alignment = PP_ALIGN.CENTER
                tr = tp.add_run()
                tr.text = str(c.get("title", ""))
                set_run(tr, 16, theme["fg"], True)

                dtf = textbox(slide, x + 0.18, 4.05, card_w - 0.36, 1.9)
                dp = dtf.paragraphs[0]
                dp.alignment = PP_ALIGN.CENTER
                dr = dp.add_run()
                dr.text = str(c.get("text", ""))
                set_run(dr, 11.5, theme["muted"])
        else:
            img_left = has_img and idx % 2 == 0
            if has_img and img_left:
                # 图在左：图 0.75~4.95，文字从 5.35 开始
                text_left, text_w = 5.35, 7.2
                pic_x, pic_w = 0.75, 4.2
            elif has_img:
                # 图在右：文字 0.8~8.0，图从 8.35 开始，互不重叠
                text_left, text_w = 0.8, 7.1
                pic_x, pic_w = 8.35, 4.25
            else:
                text_left, text_w = 0.9, 11.3
                pic_x, pic_w = 0, 0

            tf = textbox(slide, text_left, 0.7, text_w, 1.05)
            p = tf.paragraphs[0]
            r = p.add_run()
            r.text = s.get("title", "")
            set_run(r, 26 if (has_img or chart) else 28, theme["fg"], True)

            body_top = 1.9
            body = textbox(slide, text_left, body_top, text_w, 4.95)
            bullets = s.get("bullets") or []
            symbols = ["◆", "●", "▸", "✦", "■", "▲"]
            total_chars = sum(len(str(b)) for b in bullets)
            body_size = 15 if total_chars <= 150 else (13.5 if total_chars <= 220 else 12)
            if not (has_img or chart):
                body_size = 16
            for i, b in enumerate(bullets):
                p = body.paragraphs[0] if i == 0 else body.add_paragraph()
                p.space_after = Pt(8)
                p.line_spacing = 1.15
                mark = p.add_run()
                mark.text = symbols[i % len(symbols)] + "  "
                set_run(mark, 11, theme["accent"], True)
                rr = p.add_run()
                rr.text = str(b)
                set_run(rr, body_size, theme["fg"])

            if has_img:
                pic = slide.shapes.add_picture(s["image"], Inches(pic_x), Inches(1.95), width=Inches(pic_w))
                if pic.height > Inches(4.8):
                    ratio = pic.width / pic.height
                    pic.height = Inches(4.8)
                    pic.width = int(Inches(4.8) * ratio)
                # 竖直居中一点，别贴顶
                pic.top = Inches(1.95 + max(0, (4.8 - pic.height / 914400) / 2))

            if chart:
                try:
                    cdata = CategoryChartData()
                    cdata.categories = [str(x) for x in chart.get("categories", [])][:8]
                    for ser in (chart.get("series") or [])[:3]:
                        vals = [float(v) for v in (ser.get("values") or [])][:8]
                        if len(vals) < len(cdata.categories):
                            vals = vals + [0] * (len(cdata.categories) - len(vals))
                        cdata.add_series(str(ser.get("name", "")), vals[: len(cdata.categories)])
                    kind = str(chart.get("type", "bar")).lower()
                    ctype = {
                        "bar": XL_CHART_TYPE.COLUMN_CLUSTERED,
                        "line": XL_CHART_TYPE.LINE_MARKERS,
                        "pie": XL_CHART_TYPE.PIE,
                    }.get(kind, XL_CHART_TYPE.COLUMN_CLUSTERED)
                    gframe = slide.shapes.add_chart(ctype, Inches(8.1), Inches(1.95), Inches(4.55), Inches(4.5), cdata)
                    ch = gframe.chart
                    # 明确给柱/线配色，避免某些查看器把柱子渲染成白色
                    for ser in ch.series:
                        try:
                            ser.format.fill.solid()
                            ser.format.fill.fore_color.rgb = rgb(theme["accent"])
                            ser.format.line.color.rgb = rgb(theme["accent"])
                        except Exception:
                            pass
                    try:
                        plot0 = ch.plots[0]
                        plot0.has_data_labels = True
                        plot0.data_labels.font.size = Pt(10)
                        plot0.data_labels.font.name = FONT
                        plot0.data_labels.font.color.rgb = rgb(theme["fg"])
                    except Exception:
                        pass
                    ch.has_legend = kind == "pie" or len(chart.get("series") or []) > 1
                    if ch.has_legend:
                        ch.legend.position = XL_LEGEND_POSITION.BOTTOM
                        ch.legend.include_in_layout = False
                    if chart.get("title"):
                        ch.has_title = True
                        ch.chart_title.text_frame.text = str(chart["title"])[:40]
                        for rp in ch.chart_title.text_frame.paragraphs:
                            for run_ in rp.runs:
                                run_.font.size = Pt(12)
                                run_.font.name = FONT
                except Exception as exc:  # 图表数据不合法就跳过，别让整份 PPT 失败
                    print("chart skipped:", exc)

        # 页码
        pg = textbox(slide, 12.2, 6.95, 0.9, 0.4)
        p = pg.paragraphs[0]
        p.alignment = PP_ALIGN.RIGHT
        r = p.add_run()
        r.text = f"{idx} / {total}"
        set_run(r, 11, theme["muted"])

        notes = s.get("notes")
        if notes:
            slide.notes_slide.notes_text_frame.text = str(notes)

    # 结束页
    slide = prs.slides.add_slide(blank)
    add_bg(slide, prs, theme["accent"])
    tf = textbox(slide, 0, 2.9, 13.333, 1.2)
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    r.text = "谢 谢 观 看"
    set_run(r, 40, "FFFFFF", True)
    tf2 = textbox(slide, 0, 4.1, 13.333, 0.6)
    p2 = tf2.paragraphs[0]
    p2.alignment = PP_ALIGN.CENTER
    r2 = p2.add_run()
    r2.text = spec.get("subtitle", "")
    set_run(r2, 14, "F0E6D8")

    prs.save(out_path)
    return out_path


def _width(text):
    s = str(text or "")
    return sum(2 if ord(ch) > 127 else 1 for ch in s)


def cache_xlsx_formulas(wb, out_path):
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
                    except (ValueError, TypeError, SyntaxError, ZeroDivisionError, RecursionError, OverflowError, KeyError):
                        pass
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

    for sh in (spec.get("sheets") or [])[:3]:
        name = str(sh.get("name") or "Sheet1")[:28]
        ws = wb.create_sheet(title=name)
        ws.sheet_view.showGridLines = False
        cols = [str(c) for c in (sh.get("columns") or [])]
        row = 1
        if spec.get("title"):
            span = max(1, len(cols))
            ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=span)
            cell = ws.cell(row=1, column=1, value=str(spec["title"])[:60])
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
                cell.border = border

        for j in range(1, max(1, len(cols)) + 1):
            longest = _width(cols[j - 1] if j <= len(cols) else "")
            for i in range(row + 1, ws.max_row + 1):
                value = ws.cell(row=i, column=j).value
                if not (isinstance(value, str) and value.startswith("=")):
                    longest = max(longest, _width(value))
            ws.column_dimensions[get_column_letter(j)].width = min(44, max(16, longest + 5))

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

    if not wb.sheetnames:
        wb.create_sheet(title="Sheet1")
    wb.save(out_path)
    cache_xlsx_formulas(wb, out_path)
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
