import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from asr_clarification import clarification_fields, term_candidates


def piece(start, primary, alternate):
    return dict(start=start, end=start+len(primary), choices=[
        dict(text=primary, support=[1,0,0], lm=-4., gap=0.),
        dict(text=alternate, support=[0,1,1], lm=-3.9, gap=.1)])


class ClarificationRules(unittest.TestCase):
    def test_instruction_with_two_disputed_details_asks_only_one(self):
        base="订单追加十三箱，发给佟健"
        alt="订单追加三十箱，发给董建"
        evidence=[piece(base.index("十三"),"十三","三十"), piece(base.index("佟健"),"佟健","董建")]
        questions=clarification_fields(base,[base,alt,alt],evidence)
        self.assertEqual(len(questions),1)
        q=questions[0]
        self.assertIn(q['label'],['名字','数量'])
        self.assertEqual(base[q['start']:q['end']],q['options'][0])

    def test_equivalent_numbers_and_units_do_not_prompt(self):
        base="需要四千毫米"
        alt="需要4000mm"
        self.assertEqual(clarification_fields(base,[base,alt,alt],[piece(2,"四千毫米","4000mm")]),[])

    def test_function_words_do_not_prompt(self):
        self.assertEqual(list(term_candidates("努力地工作",[piece(2,"地","的")])),[])

    def test_local_alternatives_include_word_context(self):
        qs=list(term_candidates("研究两种补贴",[piece(2,"两","良")]))
        self.assertTrue(qs)
        field=qs[0][1]
        self.assertIn("两种",field['options'][0])
        self.assertTrue(any('良种' in s for s in field['options']))


if __name__ == '__main__':
    unittest.main()
