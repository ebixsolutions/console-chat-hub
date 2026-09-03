#!/usr/bin/env python3
from pathlib import Path
p=Path('supabase/functions/_shared/conversation-semantic-contract.ts')
s=p.read_text()
old='''const SUMMARY = /(?:總結|总结|概括|歸納|归纳).*(?:剛才|刚才|以上|之前|我們|我们|內容|内容|三點|三点)?|summari[sz]e(?: that| it| this| the above| what we discussed| our conversation)?/i;'''
new='''const SUMMARY = /(?:總結|总结|概括|歸納|归纳).*(?:剛才|刚才|以上|之前|我們|我们|內容|内容|三點|三点)?|(?:根據|根据)?(?:已確認|已确认)(?:資料|资料).*(?:列|分成|整理成)?\\s*(?:[一二兩两三四五六七八九十]|\\d{1,2})\\s*(?:點|点|項|项|條|条)|summari[sz]e(?: that| it| this| the above| what we discussed| our conversation)?/i;'''
if s.count(old)!=1: raise SystemExit(f'PATCH_EXPECTED_ONCE count={s.count(old)}')
s=s.replace(old,new,1)
p.write_text(s)
print('TASK2_FIXED_COUNT_SUMMARY_PATCH=PASS')
