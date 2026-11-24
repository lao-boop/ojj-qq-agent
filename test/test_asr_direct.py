from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from asr_direct import apply_choices,observations,consistent_numbers,apply_homophones


class Context:
    def likelihood(self,*args):
        return 0.


class Acoustic:
    def annotate(self,*args):
        pass


class DirectTest(unittest.TestCase):
    def choose(self,base,alternative,fields):
        original=[base]*3
        extra=[alternative]*4
        segments=observations(None,base,original,extra,fields,Context(),Acoustic())
        weights=[0.]*35
        weights[5]=2.   # Prefer the supplementary Zipformer reading in this fixture.
        return apply_choices(base,fields,segments,weights,0.)

    def test_shifts_original_question_and_preserves_options(self):
        text='把清单给老王确认'
        q=dict(start=4,end=6,label='名字',options=['老王','老黄'])
        selected,fields=self.choose(text,'把采购清单给老黄确认',[q])
        self.assertEqual(selected,'把采购清单给老王确认')
        self.assertEqual(fields,[dict(q,start=6,end=8)])
        self.assertEqual(q['start'],4)

    def test_new_disagreement_never_creates_a_question(self):
        text,qs=self.choose('本季度的定单','本季度的订单',[])
        self.assertEqual((text,qs),('本季度的订单',[]))

    def test_insertion_at_question_boundary_leaves_field_alone(self):
        q=dict(start=1,end=3,label='名字',options=['老王','老黄'])
        self.assertEqual(self.choose('给老王看','给小老王看',[q]),('给老王看',[q]))

    def test_date_and_range_with_retained_question(self):
        text='2025年六月十四日请老王来，10点到十一点'
        pos=text.index('老王')
        q=dict(start=pos,end=pos+2,label='名字',options=['老王','老黄'])
        result,fields=consistent_numbers(text,[q],['date','range'])
        self.assertEqual(result,'2025年6月14日请老王来，10点到11点')
        self.assertEqual(result[fields[0]['start']:fields[0]['end']],'老王')
        self.assertEqual(consistent_numbers('一到三只猫',[],['range'])[0],'一到三只猫')

    def test_unavailable_second_read_does_not_vote(self):
        sample=observations(None,'请开会',['请开会']*3,['请开会','请开会','请散会',None],
                            [],Context(),Acoustic())
        self.assertTrue(sample)
        self.assertTrue(all(c['support'][7]==0 for s in sample for c in s['choices']))

    def test_homophone_confidence_gate(self):
        self.assertEqual(apply_homophones('他来了',[],[(0,'它','pronoun',1.)],{'pronoun':3.})[0],'他来了')


if __name__=='__main__':
    unittest.main()
