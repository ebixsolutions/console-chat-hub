export type GroundingAuthority = "CURRENT_KB" | "PRIOR_GROUNDED_ANSWER" | "CONVERSATION_FACTS";

export interface GroundingEvidenceSet {
  authority: GroundingAuthority;
  evidence_text: string;
  chunk_ids: string[];
  transform_operations: string[];
}

export function buildConversationFactsEvidence(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): GroundingEvidenceSet | null {
  const lines = messages
    .slice(-12)
    .filter((message) => typeof message?.content === "string" && message.content.trim().length > 0)
    .map((message) => {
      const role = message.role === "assistant" ? "Assistant" : "Visitor";
      return `[${role}] ${message.content.trim().slice(0, 3000)}`;
    });
  if (!lines.length) return null;
  return {
    authority: "CONVERSATION_FACTS",
    evidence_text: lines.join("\n").slice(0, 12000),
    chunk_ids: [],
    transform_operations: [],
  };
}

export function mergeGroundingEvidence(
  primary: GroundingEvidenceSet,
  conversation: GroundingEvidenceSet | null,
): GroundingEvidenceSet {
  if (!conversation || !conversation.evidence_text.trim()) return primary;
  return {
    ...primary,
    evidence_text: `${primary.evidence_text}\n\nConversation Facts (customer-provided context; not authoritative KB):\n${conversation.evidence_text}`,
  };
}
