export type WidgetMessage = {
  id: string;
  role: "visitor" | "assistant" | "agent" | "system";
  content: string;
  meta?: string;
  isError?: boolean;
};

/** Partial readbacks never delete history. Only an explicit conversation switch
 * may reset it. Unchanged canonical rows keep their object and React key. */
export function mergeWidgetMessages<T extends WidgetMessage>(
  previous: T[], incoming: T[],
): T[] {
  const result = [...previous];
  const positions = new Map(result.map((row, index) => [row.id, index]));
  let changed = false;
  for (const row of incoming) {
    if (!row.id || !["visitor", "assistant", "agent", "system"].includes(row.role)) continue;
    const index = positions.get(row.id);
    if (index === undefined) {
      positions.set(row.id, result.length);
      result.push(row);
      changed = true;
    } else {
      const old = result[index];
      if (old.role !== row.role || old.content !== row.content ||
          old.meta !== row.meta || old.isError !== row.isError) {
        result[index] = row;
        changed = true;
      }
    }
  }
  return changed ? result : previous;
}
