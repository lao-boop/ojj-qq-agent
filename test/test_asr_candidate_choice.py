from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from asr_candidate_choice import review


def rule(**overrides):
    return dict({'votes':1,'whole':0,'lead':-6,'witness':[],'form':'any','signal':None},**overrides)


class CandidateReviewTest(unittest.TestCase):
    def test_minority_pronoun_needs_independent_confirmation(self):
        base='天气风险他们影响行程'
        alternative=base.replace('他们','它们')
        donors=[base,alternative,base,base,base]
        rules={'pronoun':rule(votes=2,witness=[5])}
        listen=Mock(return_value=alternative)
        self.assertEqual(review(base,[],donors,rules,{},listen),(alternative,[]))
        listen.assert_called_once()
        self.assertEqual(review(base,[],donors,rules,{},lambda:base),(base,[]))

    def test_protected_text_moves_and_question_is_not_reworded(self):
        base='2025年找老王'
        donor='二零二五年找老黄'
        field=dict(start=6,end=8,label='名字',options=['老王','老黄'])
        listen=Mock(side_effect=AssertionError('A sixth read is unnecessary'))
        text,fields=review(base,[field],[donor]*5,{'year':rule(votes=3),'lexical':rule()}, {},listen)
        self.assertEqual((text,fields),('二零二五年找老王',[field]))
        listen.assert_not_called()

    def test_materialization_shifts_original_offsets(self):
        base='100个给老王'
        donor='一百个给老王'
        q=dict(start=5,end=7,label='名字',options=['老王','老黄'])
        text,fields=review(base,[q],[donor]*5,{'count':rule(votes=3)}, {},lambda:None)
        self.assertEqual(text,'一百个给老王')
        self.assertEqual(fields,[dict(q,start=4,end=6)])

    def test_sixth_model_cannot_introduce_an_unheard_alternative(self):
        listen=Mock(side_effect=AssertionError('No primary disagreement'))
        self.assertEqual(review('甲',[],['甲']*5,{'lexical':rule()}, {},listen),('甲',[]))


if __name__=='__main__':
    unittest.main()
