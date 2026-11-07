type Page<T> = { data: T[] | null; error: { message: string } | null; count?: number | null };
type ReadResult<T> = { data: T; error: null } | { data: null; error: { message: string } };
const PAGE_SIZE = 200;

/** The caller supplies the normal authenticated, RLS-scoped query. */
export async function readInboxConversations<T extends { id: string }>(
  page: (from: number, to: number) => PromiseLike<Page<T>>,
): Promise<ReadResult<T[]>> {
  try {
    const rows: T[] = [];
    const seen = new Set<string>();
    let expected: number | null = null;
    for (let from = 0; ; from += PAGE_SIZE) {
      const result = await page(from, from + PAGE_SIZE - 1);
      if (result.error) return { data: null, error: result.error };
      if (!Number.isInteger(result.count) || result.count! < 0) {
        return { data: null, error: { message: "Inbox row count is unavailable. Please refresh." } };
      }
      if (expected === null) expected = result.count!;
      if (result.count !== expected) {
        return { data: null, error: { message: "Inbox changed while loading. Please refresh." } };
      }
      for (const row of result.data ?? []) {
        if (seen.has(row.id)) return { data: null, error: { message: "Inbox changed while loading. Please refresh." } };
        seen.add(row.id);
        rows.push(row);
      }
      if (rows.length === expected) return { data: rows, error: null };
      if ((result.data?.length ?? 0) < PAGE_SIZE || rows.length > expected) {
        return { data: null, error: { message: "Inbox response is incomplete. Please refresh." } };
      }
    }
  } catch {
    return { data: null, error: { message: "Unable to load conversations. Please refresh." } };
  }
}

type PreviewMessage = { conversation_id: string; content: string; is_recalled: boolean | null };

/** Stop only when every ticket has a preview or its message stream is exhausted. */
export async function readInboxPreviews(
  ids: string[],
  page: (ids: string[], from: number, to: number) => PromiseLike<Page<PreviewMessage>>,
): Promise<ReadResult<Record<string, string>>> {
  try {
    const previews: Record<string, string> = {};
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batch = ids.slice(offset, offset + 50);
      const allowed = new Set(batch);
      for (let from = 0; ; from += PAGE_SIZE) {
        const result = await page(batch, from, from + PAGE_SIZE - 1);
        if (result.error) return { data: null, error: result.error };
        for (const row of result.data ?? []) {
          if (!allowed.has(row.conversation_id)) {
            return { data: null, error: { message: "Unexpected inbox preview scope." } };
          }
          if (!(row.conversation_id in previews)) {
            previews[row.conversation_id] = row.is_recalled ? "[訊息已撤回]" : row.content.slice(0, 80);
          }
        }
        if (batch.every(id => id in previews) || (result.data?.length ?? 0) < PAGE_SIZE) break;
      }
    }
    return { data: previews, error: null };
  } catch {
    return { data: null, error: { message: "Unable to load conversation previews. Please refresh." } };
  }
}

/** Search only the already-authorized inbox IDs; never broaden to other tickets. */
export async function readInboxHistoryMatches(
  ids: string[],
  page: (ids: string[], from: number, to: number) => PromiseLike<Page<{ id: string; conversation_id: string }>>,
): Promise<ReadResult<string[]>> {
  const matched = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = [...new Set(ids.slice(offset, offset + 50))];
    const rows = await readInboxConversations((from, to) => page(batch, from, to));
    if (rows.error) return { data: null, error: rows.error };
    for (const row of rows.data) {
      if (!batch.includes(row.conversation_id)) return { data: null, error: { message: "Unexpected inbox search scope." } };
      matched.add(row.conversation_id);
    }
  }
  return { data: [...matched], error: null };
}
/** Treat operator input as a literal substring, not a SQL wildcard. */
export function inboxSearchPattern(query: string): string {
  return "%" + query.trim().replace(/[\\%_]/g, char => "\\" + char) + "%";
}
