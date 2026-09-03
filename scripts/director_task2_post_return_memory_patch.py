from pathlib import Path

semantic = Path('supabase/functions/_shared/conversation-semantic-contract.ts')
s = semantic.read_text()
old = '''const MEMORY = /(一開始|一开始|第一個問題|第一个问题|最初).*(?:問|問題|问题)|剛才.*(?:建議|建议|叫我|要我)|刚才.*(?:建议|叫我|要我)|之前.*(?:建議|建议|提供)|what\\s+(?:did\\s+i\\s+ask|was\\s+(?:my\\s+)?first)|what\\s+did\\s+you\\s+(?:recommend|suggest)|what\\s+information\\s+have\\s+i\\s+already\\s+given|what\\s+have\\s+i\\s+already\\s+given|我(?:現在|现在|目前).*(?:哪個|哪个|什麼|什么).*(?:地區|地区).*(?:哪個|哪个|什麼|什么).*(?:項目|项目)|what(?:\\x27s| is)?\\s+(?:the\\s+)?(?:current\\s+)?(?:region|jurisdiction).*(?:item|product)|what.*still\\s+missing/i;'''
new = '''const MEMORY = /(一開始|一开始|第一個問題|第一个问题|最初).*(?:問|問題|问题)|(?:剛才|刚才).*(?:主要)?(?:問|问).*(?:什麼|什么|咩)|(?:主要)(?:問|问).*(?:什麼|什么|咩)|剛才.*(?:建議|建议|叫我|要我)|刚才.*(?:建议|叫我|要我)|之前.*(?:建議|建议|提供)|what\\s+(?:did\\s+i\\s+ask|was\\s+(?:my\\s+)?first)|what\\s+(?:was|is)\\s+(?:my\\s+)?(?:main|mainly|primary).*(?:question|asking|ask)|what\\s+did\\s+you\\s+(?:recommend|suggest)|what\\s+information\\s+have\\s+i\\s+already\\s+given|what\\s+have\\s+i\\s+already\\s+given|我(?:現在|现在|目前).*(?:哪個|哪个|什麼|什么).*(?:地區|地区).*(?:哪個|哪个|什麼|什么).*(?:項目|项目)|what(?:\\x27s| is)?\\s+(?:the\\s+)?(?:current\\s+)?(?:region|jurisdiction).*(?:item|product)|what.*still\\s+missing/i;'''
assert s.count(old) == 1, f'semantic MEMORY anchor count={s.count(old)}'
semantic.write_text(s.replace(old, new, 1))

runtime = Path('supabase/functions/_shared/conversation-runtime-state.ts')
r = runtime.read_text()
old2 = '''  const generalSummaryRequest = /(最後|最后|請|请)?\\s*(?:用.{0,8})?(?:三點|三点|幾點|几点)?\\s*(?:總結|总结).*(?:剛才|刚才|我們|我们|談過|谈过|內容|内容)|summari[sz]e.*(?:conversation|discussed|talked|so far)/i.test(latest);'''
new2 = old2 + '''\n  const mainlyAskedRequest = /(?:剛才|刚才).*(?:主要)?(?:問|问).*(?:什麼|什么|咩)|(?:主要)(?:問|问).*(?:什麼|什么|咩)|what\\s+(?:was|is)\\s+(?:my\\s+)?(?:main|mainly|primary).*(?:question|asking|ask)/i.test(latest);'''
assert r.count(old2) == 1, f'runtime general summary anchor count={r.count(old2)}'
r = r.replace(old2, new2, 1)
old3 = '''  if (!(firstRequest || correctionRequest || constraintRequest || summaryRequest || recommendationRequest || providedMissingRequest || generalSummaryRequest || nameRequest || locationRequest || currentContextRequest)) return null;'''
new3 = '''  if (!(firstRequest || correctionRequest || constraintRequest || summaryRequest || recommendationRequest || providedMissingRequest || generalSummaryRequest || mainlyAskedRequest || nameRequest || locationRequest || currentContextRequest)) return null;'''
assert r.count(old3) == 1, f'runtime guard anchor count={r.count(old3)}'
r = r.replace(old3, new3, 1)
anchor4 = '''  if (providedMissingRequest) {'''
insert4 = '''  if (mainlyAskedRequest) {
    const label: Record<string, Record<RuntimeLanguage,string>> = {
      hong_kong:{"zh-TW":"香港","zh-CN":"香港",en:"Hong Kong"}, macau:{"zh-TW":"澳門","zh-CN":"澳门",en:"Macau"}, singapore:{"zh-TW":"新加坡","zh-CN":"新加坡",en:"Singapore"}, taiwan:{"zh-TW":"台灣","zh-CN":"台湾",en:"Taiwan"}, mainland_china:{"zh-TW":"中國大陸","zh-CN":"中国大陆",en:"Mainland China"}, mars:{"zh-TW":"火星","zh-CN":"火星",en:"Mars"}
    };
    const region = state.jurisdiction ? label[state.jurisdiction]?.[lang] : undefined;
    const item = state.current_item ? localizedCurrentItem(state.current_item, lang) : "";
    if (region && item) {
      if (lang === "en") return `You were mainly asking about ${item} in ${region}.`;
      if (lang === "zh-CN") return `你刚才主要问的是${region}的${item}相关问题。`;
      return `你剛才主要問的是${region}的${item}相關問題。`;
    }
    if (state.first_customer_turn) {
      if (lang === "en") return `You were mainly asking about: ${state.first_customer_turn}`;
      if (lang === "zh-CN") return `你刚才主要问的是：${state.first_customer_turn}`;
      return `你剛才主要問的是：${state.first_customer_turn}`;
    }
    return lang === "en" ? en.none : q.none;
  }
  if (providedMissingRequest) {'''
assert r.count(anchor4) == 1, f'runtime insertion anchor count={r.count(anchor4)}'
r = r.replace(anchor4, insert4, 1)
runtime.write_text(r)
print('DIRECTOR_TASK2_POST_RETURN_MEMORY_PATCH=PASS')
