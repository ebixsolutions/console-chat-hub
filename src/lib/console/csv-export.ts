/** Export only caller-authorized read results. No transport or data writes. */
export type CsvCell = string | number | boolean | null | undefined;
export function csvText(rows: CsvCell[][]): string {
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        row
          .map((value) => {
            const raw = value == null ? "" : String(value);
            // Quoting alone does not stop spreadsheet formulas in customer text.
            const safe =
              typeof value === "string" && /^[\s\uFEFF]*[=+@-]/.test(raw) ? "'" + raw : raw;
            return '"' + safe.replace(/"/g, '""') + '"';
          })
          .join(","),
      )
      .join("\r\n") +
    "\r\n"
  );
}
export function downloadCsv(filename: string, rows: CsvCell[][]): void {
  const url = URL.createObjectURL(new Blob([csvText(rows)], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
/** A failed/shifted page is never represented as a complete export. */
export async function collectExportPages<T extends { id: string }>(
  read: (
    page: number,
  ) => Promise<{ ok: true; data: { rows: T[]; total: number } } | { ok: false; error: string }>,
  size: number,
): Promise<T[]> {
  const rows: T[] = [],
    seen = new Set<string>();
  let total: number | undefined;
  for (let page = 0; ; page++) {
    const result = await read(page);
    if (!result.ok) throw new Error(result.error);
    const data = result.data;
    if (
      !Number.isSafeInteger(data.total) ||
      data.total < 0 ||
      (total !== undefined && total !== data.total)
    )
      throw new Error("export_results_changed_retry");
    total = data.total;
    if (data.rows.length !== Math.min(size, total - rows.length))
      throw new Error("export_incomplete_page");
    for (const row of data.rows) {
      if (!row.id || seen.has(row.id)) throw new Error("export_results_changed_retry");
      seen.add(row.id);
      rows.push(row);
    }
    if (rows.length === total) return rows;
  }
}
