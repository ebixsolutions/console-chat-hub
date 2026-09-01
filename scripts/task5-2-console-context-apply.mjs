import fs from 'node:fs';

const crmPath = 'src/components/console/CRMPanel.tsx';
const helperPath = 'src/lib/console/contextualKbQuery.ts';
const crm = fs.readFileSync(crmPath, 'utf8');

const importMarker = 'import { useCustomerContext } from "@/lib/customer360/useCustomerContext";\n';
if (!crm.includes(importMarker)) throw new Error('CRM import baseline marker missing');
if (crm.includes('deriveContextualKbAutoQuery')) throw new Error('CRM already contains Task 5.2 resolver');

const oldFn = `export const KB_AUTO_QUERY_MIN_CHARS = 6;\n\nexport function deriveAutoSearchQuery(boundedContext: string): string {\n  const context = boundedContext.trim();\n  if (!context) return \"\";\n  const parts = context.split(CONTEXT_SEPARATOR).map((p) => p.trim()).filter(Boolean);\n  const latest = parts.length > 0 ? parts[parts.length - 1] : \"\";\n  return latest.length >= KB_AUTO_QUERY_MIN_CHARS ? latest : context;\n}\n`;
if (!crm.includes(oldFn)) throw new Error('CRM auto-query baseline marker missing');

const helper = `export const CONSOLE_CONTEXT_SEPARATOR = " / ";
export const CONSOLE_KB_QUERY_CAP = 500;

const FOLLOW_UP_START = /^(咁|那|那麼|那么|所以|另外|仲有|还有|咁如果|那如果|而|then|so|also|what about|and what about|in that case)\\b?/i;
const REFERENCE = /(這個|这个|那個|那个|它|其|其中|上述|前面|剛才|刚才|之前|頭先|头先|同一個|同一个|same|that|this|these|those|it|its|they|them|earlier|previous|above)/i;
const TRANSFORM = /(簡單一點|简单一点|簡單啲|简单点|再講一次|再说一次|解釋給我|解释给我|只講|只说|用繁體|用简体|用英文|in english|simpler|briefly|explain that|say that again)/i;
const ELLIPSIS = /(呢[？?。.!！]*$|呢個[？?。.!！]*$|呢个[？?。.!！]*$|又如何[？?。.!！]*$|怎樣[？?。.!！]*$|怎样[？?。.!！]*$|what about .*?[？?]*$)/i;
const CORRECTION = /(我講錯|我说错|我說錯|更正|其實係|其实是|唔係.*係|不是.*是|改返|改成|actually|correction|i meant|not .* but )/i;
const STANDALONE_SIGNAL = /(型號|型号|產品|产品|訂單|订单|退款|退貨|退货|保養|保修|政策|規定|條款|价格|價錢|price|model|product|order|refund|return|warranty|policy)/i;

function clean(value: string): string {
  return value.replace(/\\s+/g, ' ').trim();
}

function isContextDependent(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  if (CORRECTION.test(t)) return true;
  if (FOLLOW_UP_START.test(t) || REFERENCE.test(t) || TRANSFORM.test(t) || ELLIPSIS.test(t)) return true;
  // Very short conversational turns commonly omit the subject even when they
  // contain a question word. Prefer a trusted prior customer anchor rather than
  // sending the fragment to KB retrieval in isolation.
  if (t.length <= 12 && /[？?呢嗎吗]|^(多久|幾耐|几耐|哪個|哪个|哪些|why|how|when|where)/i.test(t)) return true;
  return false;
}

function findAnchor(parts: string[]): string {
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const candidate = clean(parts[i] ?? '');
    if (!candidate) continue;
    if (!isContextDependent(candidate)) return candidate;
  }
  return clean(parts.at(-2) ?? '');
}

export function deriveContextualKbAutoQuery(boundedContext: string): string {
  const context = clean(boundedContext);
  if (!context) return '';
  const parts = context.split(CONSOLE_CONTEXT_SEPARATOR).map(clean).filter(Boolean);
  const latest = clean(parts.at(-1) ?? '');
  if (!latest) return '';

  // A specific new subject should not inherit an old topic merely because the
  // conversation has history. Corrections are the exception because they must
  // preserve the object being corrected while the newest value wins.
  if (!isContextDependent(latest) && (latest.length >= 6 || STANDALONE_SIGNAL.test(latest))) {
    return latest.slice(0, CONSOLE_KB_QUERY_CAP);
  }

  const anchor = findAnchor(parts);
  if (!anchor || anchor === latest) return latest.slice(0, CONSOLE_KB_QUERY_CAP);
  const joined = \\`${anchor} / ${latest}\`;
  if (joined.length <= CONSOLE_KB_QUERY_CAP) return joined;
  const latestBudget = Math.min(latest.length, Math.floor(CONSOLE_KB_QUERY_CAP * 0.45));
  const anchorBudget = CONSOLE_KB_QUERY_CAP - latestBudget - 3;
  return \\`${anchor.slice(0, anchorBudget)} / ${latest.slice(-latestBudget)}\`;
}
`;

fs.mkdirSync('src/lib/console', { recursive: true });
fs.writeFileSync(helperPath, helper);

let next = crm.replace(importMarker, importMarker + 'import { deriveContextualKbAutoQuery } from "@/lib/console/contextualKbQuery";\n');
next = next.replace(oldFn, `export const KB_AUTO_QUERY_MIN_CHARS = 6;\n\nexport function deriveAutoSearchQuery(boundedContext: string): string {\n  return deriveContextualKbAutoQuery(boundedContext);\n}\n`);
fs.writeFileSync(crmPath, next);
console.log('TASK5_2_APPLY=PASS');
