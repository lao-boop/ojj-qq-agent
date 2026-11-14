import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from openpyxl import load_workbook
from docx import Document
from pptx import Presentation

spec = importlib.util.spec_from_file_location('builder', Path(__file__).parents[1] / 'scripts' / 'build_office.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class OfficeRenderTests(unittest.TestCase):
    def test_excel_headers_formulas_cached_values_and_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            output = os.path.join(directory, 'budget.xlsx')
            builder.build_xlsx({'title': '采购预算表', 'sheets': [{'name': '采购预算',
                'columns': ['品名', '数量', '单价', '金额'], 'rows': [
                    ['键盘', 2, 120, '=B3*C3'], ['鼠标', 3, 60, '=B4*C4'],
                    ['支架', 1, 80, '=B5*C5'], ['合计', None, None, '=SUM(D3:D5)']]}]}, output)
            wb = load_workbook(output)
            ws = wb.active
            self.assertEqual([ws.cell(2, col).value for col in range(1, 5)], ['品名', '数量', '单价', '金额'])
            self.assertEqual(ws['D6'].value, '=SUM(D3:D5)')
            self.assertEqual(ws['D3'].value, '=B3*C3')
            self.assertTrue(ws['A2'].font.bold)
            self.assertNotEqual(ws['A2'].font.color.rgb[-6:], 'FFFFFF')
            self.assertEqual(ws.freeze_panes, 'A3')
            self.assertEqual(ws.auto_filter.ref, 'A2:D5')
            self.assertEqual(ws.max_row, 6)
            self.assertTrue(wb.calculation.fullCalcOnLoad)
            preview = load_workbook(output, data_only=True).active
            self.assertEqual([preview[f'D{i}'].value for i in range(3, 7)], [240, 180, 80, 500])
            ws['B3'] = 3
            wb.save(output)
            builder.cache_xlsx_formulas(wb, output)
            self.assertEqual(load_workbook(output, data_only=True).active['D6'].value, 620)

    def test_unsupported_formula_is_not_executed_and_original_formula_is_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            output = os.path.join(directory, 'safe.xlsx')
            builder.build_xlsx({'sheets': [{'columns': ['表达式'], 'rows': [['=WEBSERVICE("https://example.invalid")']]}]}, output)
            self.assertEqual(load_workbook(output).active['A2'].value, '=WEBSERVICE("https://example.invalid")')
            self.assertIsNone(load_workbook(output, data_only=True).active['A2'].value)

    def test_word_and_ppt_are_valid_office_files(self):
        with tempfile.TemporaryDirectory() as directory:
            docx = os.path.join(directory, 'report.docx')
            builder.build_docx({'title': '蓝鲸计划', 'sections': [{'heading': '目标', 'paragraphs': ['完成秘书接入。']}]}, docx)
            self.assertIn('完成秘书接入。', '\n'.join(p.text for p in Document(docx).paragraphs))
            pptx = os.path.join(directory, 'report.pptx')
            builder.build_pptx({'title': '蓝鲸计划', 'slides': [{'title': '进展', 'bullets': ['已接入企业微信', '支持原文溯源']}]}, pptx)
            deck = Presentation(pptx)
            self.assertGreaterEqual(len(deck.slides), 2)
            text = '\n'.join(shape.text for slide in deck.slides for shape in slide.shapes if shape.has_text_frame)
            self.assertIn('支持原文溯源', text)


if __name__ == '__main__':
    unittest.main()
