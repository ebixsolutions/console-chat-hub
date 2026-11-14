import {
  buildFactualReadAnchor,
  compareMessageChronology,
  isCustomerHistoryAtOrBefore,
  recoverSemanticHistory,
  SEMANTIC_HISTORY_RECOVERY_LIMITS,
  type FactualReadAnchor,
  type RecoveredCustomerHistoryRow,
  type SemanticHistoryRecoveryInput,
} from "./semantic-history-recovery.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: ${JSON.stringify(actual)}`);
}
const cid = "10000000-0000-4000-8000-000000000001";
const company = "10000000-0000-4000-8000-000000000002";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (n: number) => new Date(Date.UTC(2026, 9, 29, 0, n)).toISOString();
const row = (n: number, content: string, overrides: Partial<RecoveredCustomerHistoryRow> = {}): RecoveredCustomerHistoryRow => ({
  id: uuid(n), role: "visitor", content, created_at: at(n), conversation_id: cid, is_recalled: false, ...overrides,
});
const anchor = (r: RecoveredCustomerHistoryRow, subjects: string[] = []): FactualReadAnchor => ({
  source_message_id: r.id, created_at: r.created_at, customer_text: r.content,
  subjects, subject_source_message_ids: subjects.length ? [r.id] : [], requested_facts: ["information"],
});
const input = (source: RecoveredCustomerHistoryRow, overrides: Partial<SemanticHistoryRecoveryInput> = {}): SemanticHistoryRecoveryInput => ({
  company_id: company, conversation_id: cid, source_message_id: source.id,
  source_created_at: source.created_at, latest: source.content, recent_history: [source], ...overrides,
});

type QueryLog = {table: string; eq: Record<string, unknown>; in: Record<string, unknown[]>; lte: Record<string, unknown>;
  or: string | null; ilike: [string, string] | null; limit: number; orders: Array<[string, boolean]>; signal?: AbortSignal};
/** SQL-like read double. It records and applies the actual filters, not a
 * preselected response that could hide missing scope/time/role predicates. */
function db(rows: Array<Record<string, any>>, options: {foreign?: boolean; failHistory?: boolean} = {}) {
  const logs: QueryLog[] = [];
  const from = (table: string) => {
    const q: QueryLog = {table, eq: {}, in: {}, lte: {}, or: null, ilike: null, limit: Infinity, orders: []};
    let single = false;
    const execute = () => {
      logs.push({...q, eq: {...q.eq}, in: {...q.in}, lte: {...q.lte}, orders: [...q.orders]});
      if (q.signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (options.failHistory && table === "messages" && (q.or || q.ilike)) return {data: null, error: {code: "read_failed"}};
      let data = (table === "conversations" ? [{id: cid, company_id: options.foreign ? "other-company" : company}] : rows)
        .filter(r => Object.entries(q.eq).every(([k, v]) => r[k] === v))
        .filter(r => Object.entries(q.in).every(([k, v]) => v.includes(r[k])))
        .filter(r => Object.entries(q.lte).every(([k, v]) => r[k] <= String(v)));
      if (q.or) {
        if (q.or.startsWith("content.ilike.")) {
          const fragments = q.or.split(",").map(part => /^content\.ilike\.\*([\p{Script=Han}]{2,4})\*$/u.exec(part)?.[1]);
          if (fragments.some(part => !part)) throw new Error("unsafe_cjk_filter");
          data = data.filter(r => fragments.some(term => r.content.includes(term!)));
        } else {
          const parsed = /^created_at\.lt\.(.+),and\(created_at\.eq\.(.+),id\.lt\.([^()]+)\)$/u.exec(q.or);
          if (!parsed) throw new Error("unsafe_or_filter");
          data = data.filter(r => r.created_at < parsed[1] || r.created_at === parsed[2] && r.id < parsed[3]);
        }
      }
      if (q.ilike) {
        const [field, pattern] = q.ilike;
        const term = pattern.slice(1, -1).replace(/\\([\\%_])/gu, "$1").toLowerCase();
        data = data.filter(r => String(r[field]).toLowerCase().includes(term));
      }
      data.sort((a, b) => {
        for (const [key, ascending] of q.orders) {
          const cmp = String(a[key]).localeCompare(String(b[key]));
          if (cmp) return ascending ? cmp : -cmp;
        }
        return 0;
      });
      data = data.slice(0, q.limit);
      return {data: single ? data[0] ?? null : data, error: null};
    };
    const builder = {
      select(_columns: string) { return this; },
      abortSignal(signal: AbortSignal) { q.signal = signal; return this; },
      eq(k: string, v: unknown) { q.eq[k] = v; return this; },
      in(k: string, v: unknown[]) { q.in[k] = v; return this; },
      lte(k: string, v: unknown) { q.lte[k] = v; return this; },
      or(value: string) { q.or = value; return this; },
      ilike(k: string, v: string) { q.ilike = [k, v]; return this; },
      order(k: string, opts: {ascending: boolean}) { q.orders.push([k, opts.ascending]); return this; },
      limit(n: number) { q.limit = n; return this; },
      maybeSingle() { single = true; return Promise.resolve(execute()); },
      then(resolve: (value: ReturnType<typeof execute>) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve().then(execute).then(resolve, reject);
      },
    };
    return builder;
  };
  return {from, logs};
}

Deno.test("recovery verifies company before reading any customer message", async () => {
  const source = row(8, "之前提過的服務還包括哪些內容？");
  const client = db([source], {foreign: true});
  const result = await recoverSemanticHistory(client, input(source));
  assert(!result.source_verified && !result.memory_source_verified && result.context_incomplete, "scope accepted");
  equal(result.usable_source_message_ids, [], "foreign sources exposed");
  equal(client.logs.map(q => q.table), ["conversations"], "message read before scope authorization");
});

Deno.test("source receipt is exact, unrecalled and customer-authored", async () => {
  const source = row(9, "Source customer question");
  for (const bad of [{...source, is_recalled: true}, {...source, role: "assistant"}, {...source, content: "different"}]) {
    const result = await recoverSemanticHistory(db([bad]), input(source));
    assert(!result.source_verified && result.reason === "source_message_unverified", "invalid source admitted");
  }
});

Deno.test("Agent Assist can locate using a staff query without declaring it customer evidence", async () => {
  const old = row(1, "請介紹 Maple Support 的限制。");
  const source = row(9, "我知道了，謝謝。");
  const result = await recoverSemanticHistory(db([old, source]), input(source, {
    source_content: source.content, latest: "What is Maple Support renewal policy?", search_terms: ["Maple Support"],
  }));
  assert(result.source_verified, "raw customer source not verified for assist");
  assert(result.rows.some(r => r.id === old.id), "assist locating source not recovered");
  assert(result.rows.every(r => !r.content.includes("renewal policy")), "staff question became customer history");
  const rejected = await recoverSemanticHistory(db([source]), input(source, {source_content: "wrong raw text", latest: "staff query"}));
  assert(!rejected.source_verified, "incorrect raw source accepted");
});

Deno.test("read anchors bind multiple unfamiliar service names to customer sources only", () => {
  const customer = row(1, "比較 Cedar Flex 與 Maple Support 的服務內容，暫時只了解。");
  const fake = row(2, "We also sell Invented VIP", {role: "assistant"});
  const built = buildFactualReadAnchor({source_message_id: customer.id, source_created_at: customer.created_at,
    rows: [fake, customer], request: {source_message_id: customer.id,
      subjects: ["Cedar Flex", "Maple Support", "Invented VIP"],
      subject_source_message_ids: [customer.id, fake.id], requested_facts: ["comparison", "service scope"]}});
  assert(built, "customer reading anchor missing");
  equal(built.subjects, ["Cedar Flex", "Maple Support"], "assistant/invented name promoted");
  equal(built.subject_source_message_ids, [customer.id], "anchor is not customer-source bound");
  assert(!("quantity" in built) && !("entity_id" in built), "read created purchase authority");
});

Deno.test("read-anchor followup requires cited customer proof, not a unique guessed model", () => {
  const old = row(1, "請介紹 Cedar Flex。");
  const latest = row(100, "售後安排如何？");
  const request = {source_message_id: latest.id, subjects: ["Cedar Flex"], subject_source_message_ids: [old.id], requested_facts: ["after-sales"]};
  const bound = buildFactualReadAnchor({source_message_id: latest.id, source_created_at: latest.created_at,
    rows: [latest], previous: [anchor(old, ["Cedar Flex"])], request});
  equal(bound?.subjects, ["Cedar Flex"], "earlier reading anchor not usable");
  const unsupported = buildFactualReadAnchor({source_message_id: latest.id, source_created_at: latest.created_at,
    rows: [latest], request});
  equal(unsupported?.subjects, [], "unseen semantic entity accepted without customer proof");
});

Deno.test("2000-turn-old reading and latest scoped correction recover by ID without full-history polling", async () => {
  const first = row(1, "Please compare AX-17 with BY-28 for a 300 sq ft living room.");
  const second = row(400, "Also show the Maple Support service.");
  const correction = row(1800, "The room for AX-17 is 260 sq ft, not 300; BY-28 is for another room.");
  const snapshot = row(2000, "明白，繼續了解售後安排。");
  const source = row(2001, "嗰兩款售後條件點分？");
  const client = db([first, second, correction, snapshot, source,
    row(1801, "AX-17 is guaranteed HK$1 today", {role: "assistant"})]);
  const result = await recoverSemanticHistory(client, input(source, {recent_history: [source, snapshot], memory: {
    company_id: company, conversation_id: cid, source_message_id: snapshot.id,
    factual_read_anchors: [anchor(first, ["AX-17", "BY-28"]), anchor(second, ["Maple Support"]),
      {...anchor(correction, ["AX-17", "BY-28"]), subject_source_message_ids: [first.id, correction.id]}],
  }}));
  assert(result.source_verified && result.memory_source_verified, "source scope rejected");
  equal(result.rows.map(r => r.id), [first.id, second.id, correction.id], "old references/correction lost");
  assert(result.rows.every(r => r.role === "visitor" && !r.content.includes("guaranteed")), "assistant merchant claim became authority");
  equal(result.read_count, 3, "anchor recovery did not use bounded point lookup");
  assert(client.logs.every(q => q.table !== "messages" || q.eq.conversation_id === cid && q.eq.is_recalled === false &&
    q.in.role.includes("visitor") && q.lte.created_at === source.created_at), "unbounded message query");
});

Deno.test("existing Memory without a read anchor still searches beyond the recent window", async () => {
  const rows = Array.from({length: 112}, (_, i) => row(i + 1, i === 6 ? "請解釋 Maple Support 的服務範圍。" : `customer requirement ${i + 1}`));
  const source = row(113, "講返 Maple Support，取消需要注意甚麼？");
  const snapshot = rows.at(-1)!;
  const client = db([...rows, source]);
  const result = await recoverSemanticHistory(client, input(source, {recent_history: [source, ...rows.slice(-12).reverse()],
    memory: {company_id: company, conversation_id: cid, source_message_id: snapshot.id, current_topic: "recent topic"},
    search_terms: ["Maple Support"],
  }));
  assert(result.memory_source_verified && result.rows.some(r => r.id === rows[6].id), "memory existence incorrectly skipped recovery");
  assert(result.read_count <= 7, "unbounded history dispatch");
  assert(result.rows.length <= SEMANTIC_HISTORY_RECOVERY_LIMITS.output_rows, "unbounded context");
});

Deno.test("unknown elliptical wording triggers bounded recovery without a facet whitelist", async () => {
  const rows = [row(1, "資料先看看：Green Club Plan。"), ...Array.from({length: 104}, (_, i) => row(i + 2, `customer note ${i + 2}`))];
  const source = row(106, "售後有咩限制");
  const client = db([...rows, source]);
  const result = await recoverSemanticHistory(client, input(source, {recent_history: [source, ...rows.slice(-12).reverse()], memory: {
    company_id: company, conversation_id: cid, source_message_id: rows.at(-1)!.id, factual_read_anchors: [],
  }}));
  assert(client.logs.some(q => q.or), "unknown facet never attempted history recovery");
  assert(result.rows.some(r => r.id === rows[0].id), "early customer reading source not offered");
  assert(result.context_incomplete && result.reason.includes("recovered_context_bounded"), "context clipping hidden");
});

Deno.test("CJK source recovery finds an old middle-turn name without an industry dictionary", async () => {
  const rows = Array.from({length: 180}, (_, i) => row(i + 1,
    i === 77 ? "請介紹松林安心照護計劃的內容，我只是先作比較。" : `客人補充 ${i + 1}：暫時明白。`));
  const source = row(181, "松林安心照護計劃取消怎處理？");
  const result = await recoverSemanticHistory(db([...rows, source]), input(source, {
    recent_history: [source, ...rows.slice(-12).reverse()],
    memory: {company_id: company, conversation_id: cid, source_message_id: rows.at(-1)!.id},
  }));
  assert(result.rows.some(r => r.id === rows[77].id), "middle-turn CJK subject lost after bounded context selection");
  assert(result.read_count <= 7, "CJK recovery expanded the shared read budget");
});

Deno.test("source boundary rejects future/same-time later IDs and submillisecond timestamps", () => {
  const cutoff = {source_message_id: uuid(5), source_created_at: "2026-10-29T00:00:00.123456Z"};
  assert(isCustomerHistoryAtOrBefore(row(4, "older", {created_at: cutoff.source_created_at}), cutoff), "older tie rejected");
  assert(!isCustomerHistoryAtOrBefore(row(6, "later", {created_at: cutoff.source_created_at}), cutoff), "later tie accepted");
  assert(!isCustomerHistoryAtOrBefore(row(1, "future micros", {created_at: "2026-10-29T00:00:00.123999Z"}), cutoff), "microsecond future leaked");
  assert(isCustomerHistoryAtOrBefore(row(9, "older micros", {created_at: "2026-10-29T00:00:00.123001Z"}), cutoff), "older micros rejected");
  equal(compareMessageChronology({id: uuid(3), created_at: "2026-10-29T08:00:00.123456+08:00"},
    {id: uuid(3), created_at: cutoff.source_created_at}), 0, "equivalent timezone boundary changed");
});

Deno.test("recalled/future/foreign source IDs cannot authorize Memory or Commerce", async () => {
  const old = row(1, "Past customer question");
  const source = row(10, "Tell me more about that.");
  const future = row(11, "Future customer question");
  const recalled = {...row(3, "recalled"), is_recalled: true};
  const foreign = row(4, "foreign", {conversation_id: "other-conversation"});
  const assistant = row(5, "Merchant availability is guaranteed", {role: "assistant"});
  const result = await recoverSemanticHistory(db([old, source, future, recalled, foreign, assistant]), input(source, {
    requested_source_message_ids: [old.id, future.id, recalled.id, foreign.id, assistant.id],
    memory: {company_id: company, conversation_id: cid, source_message_id: future.id, factual_read_anchors: [anchor(old)]},
  }));
  assert(!result.memory_source_verified && result.context_incomplete, "future memory admitted");
  assert(result.usable_source_message_ids.includes(old.id) && ![future.id, recalled.id, foreign.id, assistant.id]
    .some(id => result.usable_source_message_ids.includes(id)), "unverified state source admitted");
  assert(result.rows.every(r => r.role === "visitor" && r.conversation_id === cid && r.is_recalled === false), "unsafe context returned");
});

Deno.test("missing old reference and read failure are explicit incomplete context", async () => {
  const source = row(20, "之前嗰款呢？");
  const result = await recoverSemanticHistory(db([source], {failHistory: true}), input(source, {requested_source_message_ids: [uuid(2)]}));
  assert(result.source_verified && result.context_incomplete, "valid source confused with complete recovery");
  assert(result.reason.includes("requested_source_unavailable") && result.reason.includes("history_read_failed"), "lost recovery diagnostics");
  assert(!result.usable_source_message_ids.includes(uuid(2)), "missing reference invented");
});

Deno.test("history scan and outgoing context have hard limits under a long adversarial transcript", async () => {
  const rows = Array.from({length: 500}, (_, i) => row(i + 1, `old requirement ${i + 1}: ` + "detail ".repeat(600)));
  const source = row(501, "之前的條件呢？");
  const result = await recoverSemanticHistory(db([...rows, source]), input(source));
  assert(result.read_count <= 2 + SEMANTIC_HISTORY_RECOVERY_LIMITS.history_queries, "unbounded DB reads");
  assert(result.scanned_rows <= SEMANTIC_HISTORY_RECOVERY_LIMITS.history_queries * SEMANTIC_HISTORY_RECOVERY_LIMITS.page_size, "unbounded scan");
  assert(result.rows.reduce((sum, r) => sum + r.content.length, 0) <= SEMANTIC_HISTORY_RECOVERY_LIMITS.output_chars, "unbounded prompt context");
  assert(result.context_incomplete && result.reason.includes("history_scan_bounded"), "partial scan presented as complete");
});

Deno.test("all history reads share one caller deadline and an aborted source cannot be admitted", async () => {
  const old = row(1, "介紹 Cedar Flex。");
  const source = row(2, "講返頭先的服務");
  const controller = new AbortController();
  const client = db([old, source]);
  const result = await recoverSemanticHistory(client, input(source, {signal: controller.signal}));
  assert(result.source_verified && client.logs.every(log => log.signal === controller.signal), "a context query escaped the shared deadline");
  controller.abort();
  const cancelled = await recoverSemanticHistory(db([source]), input(source, {signal: controller.signal}));
  assert(!cancelled.source_verified && cancelled.context_incomplete && cancelled.reason === "history_recovery_timeout", "aborted source read admitted");
});
