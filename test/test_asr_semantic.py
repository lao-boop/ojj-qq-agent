from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from asr_semantic import prepare,decide


class SemanticTest(unittest.TestCase):
    def setUp(self):
        self.base='讨论运输计划需要海运然后联系老王'
        self.alt=self.base.replace('海运','航运')
        self.a=self.base.index('海运')
        self.b=self.a+2
        self.words=[dict(text='海运',support=[1,0,0]),dict(text='航运',support=[0,1,0]),
                    dict(text='货运',support=[0,0,1])]
        self.core={(self.a,self.b):{tuple(c['text']):c for c in self.words}}
        self.donors=[self.base,self.alt,self.base.replace('海运','货运'),self.base,self.base]
        self.q=[dict(start=self.base.index('老王'),end=len(self.base),label='名字',options=['老王','老黄'])]

    def test_only_corroborated_semantic_winner_is_applied(self):
        spans=prepare(self.base,self.q,self.core,self.donors)
        self.assertEqual(len(spans),1)
        for c in spans[0]['choices']:
            c.update(judge=0 if c['text']=='航运' else -7,both_orders=c['text']=='航运')
        self.assertEqual(decide(self.base,self.q,spans,lambda:self.alt)[:2],(self.alt,self.q))
        self.assertEqual(decide(self.base,self.q,spans,lambda:self.base)[:2],(self.base,self.q))
        spans[0]['choices'][1]['both_orders']=False
        self.assertEqual(decide(self.base,self.q,spans,Mock(side_effect=AssertionError))[:2],(self.base,self.q))

    def test_question_area_is_protected(self):
        field=dict(start=self.a,end=self.b,label='用词',options=['海运','航运'])
        self.assertFalse(prepare(self.base,[field],self.core,self.donors))
