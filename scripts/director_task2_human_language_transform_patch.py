from pathlib import Path

path = Path('supabase/functions/_shared/conversation-semantic-contract.ts')
text = path.read_text()
old = r'''const SIMPLIFY = /(?:簡單|简单)(?:一點|一点|啲|些|點|点)?(?:[。.!！?？\s]*$|.*(?:解釋|解释|講|讲|說|说|介紹|介绍))|(?:講|讲|說|说)(?:得|得再)?(?:簡單|简单)(?:一點|一点|啲|些|點|点)?|explain(?: it| that)? (?:more )?simply|make it simpler|\bsimpler\b|\bshorter\b/i;'''
new = r'''const SIMPLIFY = /(?:簡單|简单)(?:一點|一点|啲|些|點|点)?(?:[。.!！?？\s]*$|.*(?:解釋|解释|講|讲|說|说|介紹|介绍))|(?:講|讲|說|说)(?:得|得再)?(?:簡單|简单)(?:一點|一点|啲|些|點|点)?|(?:用|講|讲|說|说)(?:香港客戶|香港客户|一般客戶|一般客户|客戶|客户)?(?:聽得懂|听得懂|明白|易明)?(?:的|嘅)?(?:人話|人话|白話|白话|口語|口语|貼地|贴地)(?:回答|講|讲|說|说)?|(?:講|讲|說|说|回答)(?:得)?(?:自然|口語|口语|貼地|贴地)(?:一點|一点|啲)?|explain(?: it| that)? (?:more )?simply|make it simpler|\bsimpler\b|\bshorter\b|(?:say|explain|answer).*(?:plain|natural|everyday|customer-friendly) (?:language|words|terms)/i;'''
if text.count(old) != 1:
    raise SystemExit(f'expected exactly one SIMPLIFY anchor, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
print('DIRECTOR_TASK2_HUMAN_LANGUAGE_PATCH=PASS')
