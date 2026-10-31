/** Customer-authored locating references. These are neither purchase entities
 * nor evidence for merchant prices, availability, policy or completed actions. */
export interface FactualReadAnchor {
  source_message_id: string;
  created_at: string;
  customer_text: string;
  subjects: string[];
  subject_source_message_ids: string[];
  requested_facts: string[];
  text_truncated?: boolean;
}

export interface FactualReadRequest {
  source_message_id: string;
  subjects: string[];
  subject_source_message_ids: string[];
  requested_facts: string[];
}

export interface SemanticRecoveryHistoryRow {
  id?: string | null;
  role?: string | null;
  content?: string | null;
  created_at?: string | null;
  conversation_id?: string | null;
  is_recalled?: boolean | null;
}

export interface RecoveredCustomerHistoryRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
  conversation_id: string;
  is_recalled: false;
}

export interface SemanticHistoryRecoveryClient {
  from(table: string): any;
}

export const SEMANTIC_HISTORY_RECOVERY_LIMITS = Object.freeze({
  anchor_count: 16,
  source_ids: 64,
  page_size: 64,
  search_queries: 2,
  history_queries: 4,
  output_rows: 24,
  output_chars: 8_000,
});

export interface SemanticHistoryRecoveryInput {
  company_id: string;
  conversation_id: string;
  source_message_id: string;
  source_created_at: string;
  latest: string;
  /** Raw server-loaded customer content when latest is a bounded business
   * projection or an Agent Assist query. The staff query is not customer fact. */
  source_content?: string;
  /** Shared caller deadline for all context reads, never reset per query. */
  signal?: AbortSignal;
  recent_history: SemanticRecoveryHistoryRow[];
  /** Either the existing persisted Memory row or its canonical memory value. */
  memory?: unknown;
  /** For example, Commerce.source_message_id. Missing IDs are not trusted. */
  requested_source_message_ids?: string[];
  /** Locating terms only, never a model-supplied tenant, filter or SQL fragment. */
  search_terms?: string[];
}

export interface SemanticHistoryRecoveryResult {
  rows: RecoveredCustomerHistoryRow[];
  source_verified: boolean;
  memory_source_verified: boolean;
  usable_source_message_ids: string[];
  candidate_source_message_ids: string[];
  context_incomplete: boolean;
  reason: string;
  read_count: number;
  scanned_rows: number;
}

const CUSTOMER = new Set(["visitor", "customer", "user"]);
const clean = (value: unknown): string => typeof value === "string"
  ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
const normalized = (value: unknown): string => clean(value).toLocaleLowerCase();
const record = (value: unknown): Record<string, any> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
const distinct = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

function time(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareTime(a: string, b: string): number {
  const millis = time(a)! - time(b)!;
  if (millis) return millis;
  // PostgreSQL timestamps can retain microseconds that Date.parse truncates.
  const remainder = (value: string) => Number((value.match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/iu)?.[1] ?? "")
    .padEnd(9, "0").slice(3, 9));
  return remainder(a) - remainder(b);
}

/** Timestamp precision and UUID tie-breaking shared by callers that assemble
 * the semantic window. Invalid source boundaries must never sort as equal. */
export function compareMessageChronology(
  a: {id: string; created_at: string},
  b: {id: string; created_at: string},
): number {
  if (!a.id || !b.id || time(a.created_at) === null || time(b.created_at) === null) {
    throw new Error("invalid_message_chronology");
  }
  return compareTime(a.created_at, b.created_at) || a.id.localeCompare(b.id);
}

/** Stable cutoff: no future turn, including a later ID with the same timestamp. */
export function isCustomerHistoryAtOrBefore(
  row: SemanticRecoveryHistoryRow,
  boundary: { source_message_id: string; source_created_at: string },
): boolean {
  const created = time(row.created_at), cutoff = time(boundary.source_created_at);
  return Boolean(row.id && CUSTOMER.has(String(row.role ?? "").toLowerCase()) &&
    created !== null && cutoff !== null &&
    (compareTime(row.created_at!, boundary.source_created_at) < 0 ||
      compareTime(row.created_at!, boundary.source_created_at) === 0 && row.id <= boundary.source_message_id));
}

function validAnchor(value: unknown): value is FactualReadAnchor {
  const anchor = record(value);
  return Boolean(anchor && clean(anchor.source_message_id) && anchor.source_message_id.length <= 80 && time(anchor.created_at) !== null &&
    typeof anchor.customer_text === "string" && anchor.customer_text.length <= 600 &&
    Array.isArray(anchor.subjects) && anchor.subjects.length <= 8 &&
    anchor.subjects.every((v: unknown) => typeof v === "string" && v.length >= 2 && v.length <= 160) &&
    Array.isArray(anchor.subject_source_message_ids) && anchor.subject_source_message_ids.length <= 16 &&
    anchor.subject_source_message_ids.every((v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 80) &&
    Array.isArray(anchor.requested_facts) && anchor.requested_facts.length <= 16 &&
    anchor.requested_facts.every((v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 160) &&
    (anchor.text_truncated === undefined || typeof anchor.text_truncated === "boolean"));
}

export function factualReadAnchors(value: unknown): FactualReadAnchor[] {
  return Array.isArray(value) ? value.filter(validAnchor).slice(-SEMANTIC_HISTORY_RECOVERY_LIMITS.anchor_count) : [];
}

/** A proposed label must occur in an actual customer source. Semantic labels
 * are useful locators but cannot mint a name absent from the conversation. */
export function buildFactualReadAnchor(input: {
  source_message_id: string;
  source_created_at: string;
  rows: SemanticRecoveryHistoryRow[];
  request?: FactualReadRequest;
  previous?: FactualReadAnchor[];
}): FactualReadAnchor | null {
  const source = input.rows.find(row => row.id === input.source_message_id &&
    CUSTOMER.has(String(row.role ?? "").toLowerCase()));
  if (!source || !clean(source.content) || time(input.source_created_at) === null ||
    source.created_at && (time(source.created_at) === null || compareTime(source.created_at, input.source_created_at) !== 0) ||
    input.request && input.request.source_message_id !== input.source_message_id) return null;
  const sourceText = clean(source.content);
  const cited = new Set(input.request?.subject_source_message_ids ?? []);
  const locatingRows = input.rows.filter(row => row.id && CUSTOMER.has(String(row.role ?? "").toLowerCase()) &&
    (row.id === input.source_message_id || cited.has(row.id)) &&
    (!row.created_at || isCustomerHistoryAtOrBefore(row, input)));
  const previous = factualReadAnchors(input.previous).filter(anchor => cited.has(anchor.source_message_id) &&
    isCustomerHistoryAtOrBefore({id: anchor.source_message_id, role: "visitor", created_at: anchor.created_at}, input));
  const proofs = [...locatingRows.map(row => ({id: row.id!, text: clean(row.content)})),
    ...previous.map(anchor => ({id: anchor.source_message_id, text: anchor.customer_text}))];
  const subjects: string[] = [], subjectIds: string[] = [];
  for (const label of distinct((input.request?.subjects ?? []).map(clean)).slice(0, 8)) {
    if (label.length < 2 || label.length > 160) continue;
    const bound = proofs.filter(proof => normalized(proof.text).includes(normalized(label)));
    if (!bound.length) continue;
    subjects.push(label);
    subjectIds.push(...bound.map(proof => proof.id));
  }
  return {
    source_message_id: input.source_message_id,
    created_at: source.created_at || input.source_created_at,
    customer_text: sourceText.slice(0, 600),
    subjects,
    subject_source_message_ids: distinct(subjectIds).slice(0, 16),
    requested_facts: distinct((input.request?.requested_facts ?? []).map(clean)).filter(value => value.length <= 160).slice(0, 16),
    ...(sourceText.length > 600 ? {text_truncated: true} : {}),
  };
}

/** These cues only trigger a bounded read; they never resolve a subject or
 * authorize a fact. An unfamiliar short question gets the same recovery as a
 * known facet, rather than a price/stock-only shortcut. */
function mayNeedHistoricalContext(latest: string): boolean {
  return latest.length <= 160 ||
    /(?:之前|先前|剛才|刚才|頭先|頭嗰|头嗰|最初|原先|上次|嗰|呢|該|该|其餘|其余|前者|後者|后者|另外一)|\b(?:it|its|this|that|these|those|earlier|previous|former|latter|first|second|original|again|both|other|back|above)\b/iu.test(latest);
}

function locatingTerms(latest: string, supplied: string[], anchors: FactualReadAnchor[]): string[] {
  const stop = /^(?:what|when|where|which|does|could|would|should|about|please|price|stock|delivery|policy|tell|have|that|this|these|those|previous|earlier|first|second|other|with|from|still|same|again)$/iu;
  const literalAnchors = anchors.flatMap(anchor => anchor.subjects)
    .filter(subject => normalized(latest).includes(normalized(subject)));
  const tokens = latest.match(/[\p{L}\p{N}]+(?:[-_/][\p{L}\p{N}]+)+|[A-Za-z][A-Za-z0-9]{3,}/gu) ?? [];
  return distinct([...supplied, ...literalAnchors, ...tokens].map(clean))
    .filter(value => value.length >= 2 && value.length <= 80 && !stop.test(value))
    .slice(0, SEMANTIC_HISTORY_RECOVERY_LIMITS.search_queries);
}

/** CJK text has no reliable whitespace word boundaries. Bounded character
 * fragments retrieve possible original wording without a product/intent
 * vocabulary. They are only recall hints; the semantic pass sees the full
 * source sentences and must still resolve ambiguity. */
function cjkLocatingFragments(latest: string): string[] {
  const fragments: string[] = [];
  for (const run of latest.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    const width = Math.min(4, run.length);
    for (let i = 0; i <= run.length - width; i++) fragments.push(run.slice(i, i + width));
  }
  const all = distinct(fragments);
  return all.length <= 16 ? all : Array.from({length: 16}, (_, i) => all[Math.floor(i * (all.length - 1) / 15)]);
}

/** Only these validated values enter a PostgREST OR expression. A supplied
 * message/tenant/name can never become an arbitrary filter expression. */
function olderThanFilter(row: RecoveredCustomerHistoryRow): string | null {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(row.id) || time(row.created_at) === null) return null;
  const fraction = row.created_at.match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/iu)?.[1] ?? "000";
  const date = new Date(row.created_at).toISOString().replace(/\.\d{3}Z$/u, `.${fraction}Z`);
  return `created_at.lt.${date},and(created_at.eq.${date},id.lt.${row.id})`;
}

/** Read-only, on-demand recovery using the existing conversation/messages
 * store. No model call, polling, schema, second memory or merchant fact source.
 * Results are candidates for semantic understanding, never a chosen referent. */
export async function recoverSemanticHistory(
  client: SemanticHistoryRecoveryClient,
  input: SemanticHistoryRecoveryInput,
): Promise<SemanticHistoryRecoveryResult> {
  const result: SemanticHistoryRecoveryResult = {
    rows: [], source_verified: false, memory_source_verified: false,
    usable_source_message_ids: [], candidate_source_message_ids: [],
    context_incomplete: false, reason: "recent_context", read_count: 0, scanned_rows: 0,
  };
  const fail = (reason: string) => ({...result, context_incomplete: true, reason});
  if (!clean(input.company_id) || !clean(input.conversation_id) || !clean(input.source_message_id) ||
    time(input.source_created_at) === null || !clean(input.latest) ||
    !clean(input.source_content ?? input.latest)) return fail("invalid_source_boundary");
  const selected = "id,conversation_id,role,content,created_at,is_recalled";
  const byId = new Map<string, RecoveredCustomerHistoryRow>();
  const validRow = (value: unknown): value is RecoveredCustomerHistoryRow => {
    const row = record(value);
    return Boolean(row && row.conversation_id === input.conversation_id && row.is_recalled === false &&
      typeof row.content === "string" && clean(row.content) && isCustomerHistoryAtOrBefore(row, input));
  };
  const withSignal = (query: any) => input.signal ? query.abortSignal(input.signal) : query;
  const base = () => withSignal(client.from("messages").select(selected)
    .eq("conversation_id", input.conversation_id).eq("is_recalled", false)
    .in("role", [...CUSTOMER]).lte("created_at", input.source_created_at));
  const notes = new Set<string>();
  try {
    result.read_count++;
    const scoped = await withSignal(client.from("conversations").select("id,company_id")
      .eq("id", input.conversation_id).eq("company_id", input.company_id)).maybeSingle();
    if (scoped.error || scoped.data?.id !== input.conversation_id || scoped.data?.company_id !== input.company_id) {
      return fail("conversation_scope_unverified");
    }
    result.read_count++;
    const source = await base().eq("id", input.source_message_id).maybeSingle();
    if (source.error || !validRow(source.data) || source.data.id !== input.source_message_id ||
      compareTime(source.data.created_at, input.source_created_at) !== 0 ||
      normalized(source.data.content) !== normalized(input.source_content ?? input.latest)) {
      return fail("source_message_unverified");
    }
    byId.set(source.data.id, source.data);
    result.source_verified = true;
    result.usable_source_message_ids = [source.data.id];

    const persisted = record(input.memory);
    const memory = record(persisted?.memory) ?? persisted;
    const memoryScope = memory?.conversation_id === input.conversation_id && memory?.company_id === input.company_id &&
      (!record(persisted?.memory) || persisted?.conversation_id === input.conversation_id && persisted?.company_id === input.company_id &&
        persisted?.source_message_id === memory?.source_message_id);
    if (memory && !memoryScope) notes.add("memory_scope_unverified");
    const memorySource = memoryScope ? clean(memory?.source_message_id) : "";
    const anchors = memoryScope ? factualReadAnchors(memory?.factual_read_anchors) : [];
    const requested = distinct((input.requested_source_message_ids ?? []).map(clean));
    const ids = distinct([memorySource, ...requested, ...anchors.flatMap(anchor =>
      [anchor.source_message_id, ...anchor.subject_source_message_ids])]).filter(id => id !== input.source_message_id);
    if (ids.length > SEMANTIC_HISTORY_RECOVERY_LIMITS.source_ids) notes.add("source_id_budget");
    if (ids.length) {
      result.read_count++;
      const loaded = await base().in("id", ids.slice(0, SEMANTIC_HISTORY_RECOVERY_LIMITS.source_ids))
        .limit(SEMANTIC_HISTORY_RECOVERY_LIMITS.source_ids);
      if (loaded.error || !Array.isArray(loaded.data)) notes.add("source_read_failed");
      else for (const row of loaded.data) if (validRow(row)) byId.set(row.id, row);
    }
    result.memory_source_verified = Boolean(memorySource && byId.has(memorySource));
    if (memorySource && !result.memory_source_verified) notes.add("memory_source_unverified");
    if (requested.some(id => !byId.has(id))) notes.add("requested_source_unavailable");

    // A recalled or future snapshot cannot supply anchors or search hints.
    const verifiedAnchors = result.memory_source_verified ? anchors.filter(anchor => {
      const raw = byId.get(anchor.source_message_id);
      return raw && compareTime(raw.created_at, anchor.created_at) === 0 &&
        normalized(raw.content).startsWith(normalized(anchor.customer_text));
    }) : [];
    if (result.memory_source_verified && verifiedAnchors.length !== anchors.length) notes.add("anchor_source_unavailable");
    const recentIds = new Set(input.recent_history.filter(validRow).map(row => row.id));
    recentIds.add(input.source_message_id);
    const candidates = new Map<string, RecoveredCustomerHistoryRow>();
    const add = (row: RecoveredCustomerHistoryRow) => {
      byId.set(row.id, row);
      if (!recentIds.has(row.id)) candidates.set(row.id, row);
    };
    // Source reads can restore both an old locating question and a later scoped
    // correction. Preserve their actual chronology; do not infer replacement.
    const verifiedAnchorIds = new Set(verifiedAnchors.flatMap(anchor => [anchor.source_message_id, ...anchor.subject_source_message_ids]));
    for (const row of byId.values()) if (verifiedAnchorIds.has(row.id) || requested.includes(row.id)) add(row);

    const terms = locatingTerms(input.latest, input.search_terms ?? [], verifiedAnchors);
    const cjkTerms = cjkLocatingFragments(input.latest);
    const explicitAnchor = verifiedAnchors.some(anchor => anchor.subjects.some(subject => normalized(input.latest).includes(normalized(subject))));
    const contextual = mayNeedHistoricalContext(input.latest);
    const missingRecentAnchors = verifiedAnchors.some(anchor => !recentIds.has(anchor.source_message_id));
    const lifecycleIncomplete = result.memory_source_verified && memory?.question_lifecycle_incomplete === true;
    const indexIncomplete = result.memory_source_verified && memory?.factual_read_anchors_incomplete === true || lifecycleIncomplete;
    if (lifecycleIncomplete) notes.add("memory_question_lifecycle_incomplete");
    const shouldRecover = Boolean((input.search_terms?.length ?? 0) ||
      requested.some(id => !recentIds.has(id)) || contextual &&
        (!verifiedAnchors.length || missingRecentAnchors || indexIncomplete));
    const needsScan = shouldRecover && (!verifiedAnchors.length || indexIncomplete ||
      !explicitAnchor && /(?:之前|先前|最初|原先|上次|頭先|头先|前者|後者|后者)|\b(?:earlier|previous|first|second|original|former|latter|back)\b/iu.test(input.latest));
    let historyReads = 0;
    if (needsScan || (input.search_terms?.length ?? 0) > 0) {
      const searches = [...terms.map(term => ({term, cjk: false})),
        ...(cjkTerms.length ? [{term: "", cjk: true}] : [])].slice(0, SEMANTIC_HISTORY_RECOVERY_LIMITS.search_queries);
      for (const search of searches) {
        if (historyReads >= SEMANTIC_HISTORY_RECOVERY_LIMITS.history_queries) break;
        result.read_count++; historyReads++;
        const escaped = search.term.replace(/[\\%_]/gu, "\\$&");
        // Only Han fragments produced above enter this OR expression: no
        // customer punctuation or untrusted filter syntax is interpolated.
        const query = search.cjk
          ? base().or(cjkTerms.map(term => `content.ilike.*${term}*`).join(","))
          : base().ilike("content", `%${escaped}%`);
        const found = await query
          .order("created_at", {ascending: false}).order("id", {ascending: false})
          .limit(SEMANTIC_HISTORY_RECOVERY_LIMITS.page_size);
        if (found.error || !Array.isArray(found.data)) notes.add("history_search_failed");
        else {
          result.scanned_rows += found.data.length;
          for (const row of found.data) if (validRow(row)) add(row);
          if (found.data.length === SEMANTIC_HISTORY_RECOVERY_LIMITS.page_size) notes.add("search_result_bounded");
        }
      }
    }
    if (needsScan) {
      // Keyset pagination is bounded to customer turns before the oldest recent
      // customer row. It is on-demand, never a recurring 500-turn rebuild.
      const recent = input.recent_history.filter(row => validRow(row)) as RecoveredCustomerHistoryRow[];
      let cursor = [...recent, source.data].sort(compareMessageChronology)[0];
      let exhausted = false;
      while (historyReads < SEMANTIC_HISTORY_RECOVERY_LIMITS.history_queries) {
        const filter = olderThanFilter(cursor);
        if (!filter) { notes.add("history_cursor_unavailable"); break; }
        result.read_count++; historyReads++;
        const page = await base().or(filter).order("created_at", {ascending: false})
          .order("id", {ascending: false}).limit(SEMANTIC_HISTORY_RECOVERY_LIMITS.page_size);
        if (page.error || !Array.isArray(page.data)) { notes.add("history_read_failed"); break; }
        result.scanned_rows += page.data.length;
        const rows = page.data.filter(validRow) as RecoveredCustomerHistoryRow[];
        for (const row of rows) add(row);
        if (page.data.length < SEMANTIC_HISTORY_RECOVERY_LIMITS.page_size) { exhausted = true; break; }
        const next = rows.at(-1);
        if (!next || next.id === cursor.id) { notes.add("history_cursor_unavailable"); break; }
        cursor = next;
      }
      if (!exhausted) notes.add("history_scan_bounded");
    }

    const anchorIds = new Set(verifiedAnchors.flatMap(anchor => [anchor.source_message_id, ...anchor.subject_source_message_ids]));
    const sourcePriority = new Set(requested);
    const rank = (row: RecoveredCustomerHistoryRow): number =>
      (sourcePriority.has(row.id) ? 100 : 0) + (anchorIds.has(row.id) ? 60 : 0) +
      [...terms, ...cjkTerms].reduce((score, term) => score + (normalized(row.content).includes(normalized(term)) ? 15 : 0), 0);
    const ordered = [...candidates.values()].sort((a, b) => rank(b) - rank(a) || compareMessageChronology(a, b));
    let chars = 0;
    for (const row of ordered) {
      const size = row.content.length + row.id.length + row.created_at.length + 80;
      if (result.rows.length >= SEMANTIC_HISTORY_RECOVERY_LIMITS.output_rows || chars + size > SEMANTIC_HISTORY_RECOVERY_LIMITS.output_chars) {
        notes.add("recovered_context_bounded"); continue;
      }
      result.rows.push(row); chars += size;
    }
    result.rows.sort(compareMessageChronology);
    if (shouldRecover && !result.rows.length && !verifiedAnchors.length &&
      !input.recent_history.some(row => row.id !== input.source_message_id && CUSTOMER.has(String(row.role ?? ""))) &&
      /(?:之前|先前|最初|原先|頭先|头先|嗰|前者|後者|后者)|\b(?:earlier|previous|former|latter|first|second|back|it|that)\b/iu.test(input.latest)) notes.add("reference_not_recovered");
    result.usable_source_message_ids = [...byId.keys()];
    result.candidate_source_message_ids = result.rows.map(row => row.id);
    result.context_incomplete = notes.size > 0;
    result.reason = [...notes].join(",") || (result.rows.length ? "customer_sources_recovered" : "recent_context");
    return result;
  } catch {
    // Any source not successfully read remains unusable. Never turn a storage
    // failure into a fabricated older referent or a missing-KB assertion.
    result.usable_source_message_ids = [...byId.keys()];
    return fail(input.signal?.aborted ? "history_recovery_timeout" : "history_recovery_unavailable");
  }
}
