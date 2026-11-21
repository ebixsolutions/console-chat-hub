/** Unknown/missing fields are visible errors, never invented customer facts. */
export function expandSavedResponse(
  content: string,
  values: Record<string, string | null | undefined>,
): string {
  const expanded = content.replace(/\{\{([^{}]+)\}\}/g, (_token, field: string) => {
    const key = field.trim();
    if (!["customer_name", "agent_name", "channel_name"].includes(key) || !values[key]?.trim())
      throw new Error(`saved_response_variable_unavailable:${key}`);
    return values[key]!;
  });
  if (expanded.length > 4000) throw new Error("saved_response_expanded_content_limit");
  return expanded;
}
