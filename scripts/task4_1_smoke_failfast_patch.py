from pathlib import Path
p = Path('scripts/integrated_final_production_smoke.py')
s = p.read_text()
old = '''        hs=(p.get('human_support') or {}).get('state')
        if expect and latest:break
        if not expect and hs not in (None,'none') and p.get('ai_generating') is False:break
        time.sleep(1)
    if expect and latest is None:fail.append('NO_REPLY:'+q)
    return latest,p
'''
new = '''        hs=(p.get('human_support') or {}).get('state')
        if expect and hs not in (None,'none'):
            fail.append('UNEXPECTED_HUMAN_CONTROL:'+q+':'+str(hs))
            break
        if expect and latest:break
        if not expect and hs not in (None,'none') and p.get('ai_generating') is False:break
        time.sleep(1)
    if expect and latest is None:fail.append('NO_REPLY:'+q)
    return latest,p
'''
if old in s:
    s=s.replace(old,new,1)
elif 'UNEXPECTED_HUMAN_CONTROL:' not in s:
    raise SystemExit('smoke send block not found')
p.write_text(s)
print('TASK4_1_SMOKE_FAILFAST=APPLIED')