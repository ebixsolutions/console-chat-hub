from pathlib import Path

p = Path('supabase/functions/generate-reply/index.ts')
s = p.read_text()

old_import = 'import { buildRealtimeR3SentimentSignals } from "../_shared/runtime-signal-lifecycle.ts";'
new_import = old_import + '\nimport { buildEmotionReplyStrategyContext } from "../_shared/emotion-reply-strategy.ts";'
assert s.count(old_import) == 1, f'import count={s.count(old_import)}'
s = s.replace(old_import, new_import, 1)

old_block = '''  const _customerAdvisoryBlock = buildCustomerAdvisoryContext({
    tier: customerContext?.tier,
    anger_flag: _pr5R3Sentiment?.anger_flag,
    sentiment_score: _pr5R3Sentiment?.sentiment_score,
    churn_risk: customerContext?.churn_risk,
    escalation_score: customerContext?.escalation_score,
  });'''
new_block = old_block + '''
  const _emotionReplyStrategyBlock = buildEmotionReplyStrategyContext({
    emotion_kind: _pr5R3Sentiment?.emotion_kind,
    emotion_intensity: _pr5R3Sentiment?.emotion_intensity,
    emotion_confidence: _pr5R3Sentiment?.emotion_confidence,
    sentiment_recovered_same_turn: _pr5R3Sentiment?.sentiment_recovered_same_turn,
  });'''
count = s.count(old_block)
assert count == 1, f'advisory block count={count}'
s = s.replace(old_block, new_block, 1)

old_prompt = '''        returnToAiGuard,
        _customerAdvisoryBlock,
        buildMaskedContextBlock(customerContext, opaqueCustomerRef),'''
new_prompt = '''        returnToAiGuard,
        _customerAdvisoryBlock,
        _emotionReplyStrategyBlock,
        buildMaskedContextBlock(customerContext, opaqueCustomerRef),'''
count = s.count(old_prompt)
assert count == 1, f'prompt insertion count={count}'
s = s.replace(old_prompt, new_prompt, 1)

assert 'buildEmotionReplyStrategyContext' in s
assert s.count('_emotionReplyStrategyBlock') == 2
p.write_text(s)
print('TASK6_2_WIRING_PATCH=PASS')
