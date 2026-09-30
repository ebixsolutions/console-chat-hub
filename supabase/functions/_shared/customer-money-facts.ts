/** Customer-owned amounts, never merchant/current-price authority. */
export interface CustomerMoneyFact {
  amount: number;
  currency: string;
  charge_basis: "per_unit" | "per_order" | "unspecified";
  labels: [string, string, string];
  source: "customer_message";
}

const MONEY = /\b(HKD|USD|TWD)\b\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|((?:HK|US|NT)\$|\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(HKD|USD|TWD)\b/gi;
const UNIT = /每\s*(?:部|台|件|個|个|份|位|晚|夜|日|天|次|堂|節|节)|per\s+(?:unit|item|piece|session|night|day|booking|seat)|\beach\b/i;
const ORDER = /每\s*(?:單|单)|整\s*(?:單|单)|合共|合計|合计|總共|总共|總額|总额|per\s+order|one[- ]?off|一次性|subtotal|sub-total|\btotal\b|altogether/i;
const ADD = /再加|加上|加埋|另外加|加多|另加|\bplus\b|\badd(?:ed)?\b/i;

export function deriveTypedCustomerMoneyFacts(text: string): {
  facts: CustomerMoneyFact[];
  historical: boolean;
} {
  const value = text.normalize("NFKC");
  const historical = /舊價|旧价|歷史|历史|假設|假设|之前|當時|当时|historical|earlier|previous|old\s+price|hypothetical|suppos|assum|\bif\b/i.test(value);
  // Split at semantic charge boundaries, preserving thousands separators.
  const clauses = value.replace(/(\d),(?=\d)/g, "$1∯")
    .split(/[，,；;。\n]+|(?=再加|加上|另外加|加多|另加|\bplus\b|\band\s+add\b)/i)
    .map((part) => part.replace(/∯/g, ","));
  const facts: CustomerMoneyFact[] = [];
  for (const clause of clauses) {
    const matches = [...clause.matchAll(MONEY)];
    // Multiple unseparated amounts have ambiguous scope. Do not invent a basis.
    const unit = UNIT.test(clause);
    const order = ORDER.test(clause) || ADD.test(clause);
    const basis = matches.length === 1 && unit !== order
      ? unit ? "per_unit" : "per_order"
      : "unspecified";
    const labels: [string, string, string] = /送貨|送货|delivery/i.test(clause)
      ? ["送貨", "送货", "delivery"]
      : /鋁架|铝架|bracket/i.test(clause)
      ? ["鋁架", "铝架", "bracket"]
      : /安裝|安装|installation/i.test(clause)
      ? ["安裝", "安装", "installation"]
      : /機價|机价|unit\s+price|每部|per\s+unit/i.test(clause)
      ? ["機價", "机价", "unit price"]
      : ["金額", "金额", "amount"];
    for (const match of matches) {
      const raw = match[2] ?? match[4] ?? match[5];
      const amount = Number(raw.replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount < 0) continue;
      const marker = (match[1] ?? match[3] ?? match[6]).toUpperCase();
      facts.push({ amount, currency: /US/.test(marker) ? "USD" : /TW|NT/.test(marker) ? "TWD" : "HKD",
        charge_basis: basis, labels, source: "customer_message" });
    }
  }
  return { facts, historical };
}
