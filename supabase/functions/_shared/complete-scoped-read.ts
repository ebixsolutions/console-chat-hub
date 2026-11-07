/** Complete read-only PostgREST queries. Factories must retain their tenant filters. */
export const READ_PAGE_SIZE = 200;
export const READ_ID_BATCH_SIZE = 50;
type Row = Record<string, any>;
type Result = { data: Row[] | null; error: any; count: number | null };
type Query = PromiseLike<Result> & {
  order(column: string, options: { ascending: boolean }): Query;
  range(from: number, to: number): Query;
};
const failure = (code = "COMPLETE_READ_FAILED") => ({ data: null, error: { code } });

export async function readComplete(makeQuery: () => Query) {
  const rows: Row[] = [], seen = new Set<string>();
  let expected: number | undefined;
  try {
    for (let offset = 0; ; offset += READ_PAGE_SIZE) {
      const { data, error, count } = await makeQuery().order("id", { ascending: true }).range(offset, offset + READ_PAGE_SIZE - 1);
      if (error) return failure();
      if (!Array.isArray(data) || !Number.isSafeInteger(count) || count! < 0) return failure("COMPLETE_READ_SHAPE");
      if (expected === undefined) expected = count!;
      if (count !== expected || data.length > READ_PAGE_SIZE || data.length !== Math.min(READ_PAGE_SIZE, Math.max(0, expected - offset))) return failure("COMPLETE_READ_CHANGED");
      for (const row of data) {
        if (!row || typeof row.id !== "string" || !row.id || seen.has(row.id)) return failure("COMPLETE_READ_DUPLICATE");
        seen.add(row.id); rows.push(row);
      }
      if (rows.length === expected) return { data: rows, error: null };
    }
  } catch { return failure(); }
}

export async function readByIds(ids: string[], field: string, makeQuery: (batch: string[]) => Query, omitId = false) {
  const all: Row[] = [], seen = new Set<string>();
  const unique = [...new Set(ids)].sort();
  for (let offset = 0; offset < unique.length; offset += READ_ID_BATCH_SIZE) {
    const batch = unique.slice(offset, offset + READ_ID_BATCH_SIZE), allowed = new Set(batch);
    const result = await readComplete(() => makeQuery(batch));
    if (result.error) return failure();
    for (const row of result.data!) {
      if (!allowed.has(row[field]) || seen.has(row.id)) return failure("COMPLETE_READ_SCOPE");
      seen.add(row.id);
      if (omitId) { const { id: _id, ...rest } = row; all.push(rest); } else all.push(row);
    }
  }
  return { data: all, error: null };
}

export async function countByIds(ids: string[], makeQuery: (batch: string[]) => PromiseLike<{ count: number | null; error: any }>) {
  const unique = [...new Set(ids)].sort(); let total = 0;
  try {
    for (let offset = 0; offset < unique.length; offset += READ_ID_BATCH_SIZE) {
      const { count, error } = await makeQuery(unique.slice(offset, offset + READ_ID_BATCH_SIZE));
      if (error || !Number.isSafeInteger(count) || count! < 0) return { count: null, error: { code: "COMPLETE_COUNT_FAILED" } };
      total += count!;
      if (!Number.isSafeInteger(total)) return { count: null, error: { code: "COMPLETE_COUNT_FAILED" } };
    }
    return { count: total, error: null };
  } catch { return { count: null, error: { code: "COMPLETE_COUNT_FAILED" } }; }
}
