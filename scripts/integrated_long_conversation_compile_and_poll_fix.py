from pathlib import Path

# CE nullability narrowing: preserve runtime semantics, make selected canonical document explicit.
p = Path('supabase/functions/_shared/ce-grounding.ts')
s = p.read_text()
old = '''  const selected = selectCanonicalGrounding(result.documents ?? [], { requestText, policyOnly, requirePublished: true });
  if (!selected.ok || !selected.document) return [];
  return selected.evidence.map((item) => {
    const matching = selected.chunks.find((c: KBFullChunk) => c.chunk_type === "full_content" && c.document_id === item.document_id && (!item.chunk_id || c.chunk_id === item.chunk_id));
    return { chunk_id:item.chunk_id ?? matching?.chunk_id ?? "", document_id:selected.document.document_id, document_title:matching?.title ?? selected.document.title ?? "KB document", citation_label:matching?.title ?? selected.document.title ?? "KB document", source_type:item.source_type || matching?.source_type || "unknown", source_scope:policyOnly ? "policy" : "customer_answer", score:item.score, version:null, last_updated_at:null, freshness_status:"fresh", content:item.content };
  });'''
new = '''  const selected = selectCanonicalGrounding(result.documents ?? [], { requestText, policyOnly, requirePublished: true });
  if (!selected.ok || !selected.document) return [];
  const selectedDocument = selected.document;
  return selected.evidence.map((item) => {
    const matching = selected.chunks.find((c: KBFullChunk) => c.chunk_type === "full_content" && c.document_id === item.document_id && (!item.chunk_id || c.chunk_id === item.chunk_id));
    return { chunk_id:item.chunk_id ?? matching?.chunk_id ?? "", document_id:selectedDocument.document_id, document_title:matching?.title ?? selectedDocument.title ?? "KB document", citation_label:matching?.title ?? selectedDocument.title ?? "KB document", source_type:item.source_type || matching?.source_type || "unknown", source_scope:policyOnly ? "policy" : "customer_answer", score:item.score, version:null, last_updated_at:null, freshness_status:"fresh", content:item.content };
  });'''
if old not in s:
    raise SystemExit('CE_GROUNDING_PATTERN_NOT_FOUND')
p.write_text(s.replace(old, new, 1))

# Widget poll: refresh human-control state after message read so acknowledgement + state are coherent.
p = Path('supabase/functions/widget-poll-messages/index.ts')
s = p.read_text()
old = '''    const humanSupportState = isHumanControlState(conv.status, conv.assigned_agent_id)
      ? (conv.assigned_agent_id ? "assigned" : "waiting")
      : "none";'''
new = '''    // Conversation control may change between the initial authorization read and
    // the message read (for example R1 handoff commits while polling). Refresh
    // only control fields after messages are loaded so the customer-visible
    // snapshot cannot contain a handoff acknowledgement with stale `none` state.
    const { data: freshControl, error: freshControlError } = await supabase.from("conversations")
      .select("status, assigned_agent_id")
      .eq("id", conversation_id)
      .maybeSingle();
    if (freshControlError) return json({ success: false, error: "conversation_control_refresh_failed" }, 500);
    if (!freshControl) return json({ success: false, error: "Conversation not found" }, 404);

    const finalStatus = freshControl.status;
    const finalAssignedAgentId = freshControl.assigned_agent_id;
    const humanSupportState = isHumanControlState(finalStatus, finalAssignedAgentId)
      ? (finalAssignedAgentId ? "assigned" : "waiting")
      : "none";'''
if old not in s:
    raise SystemExit('POLL_CONTROL_PATTERN_NOT_FOUND')
s = s.replace(old, new, 1)
s = s.replace('conversation_status: conv.status,', 'conversation_status: finalStatus,', 1)
s = s.replace('agent_assigned: Boolean(conv.assigned_agent_id),', 'agent_assigned: Boolean(finalAssignedAgentId),', 1)
p.write_text(s)

print('INTEGRATED_CE_COMPILE_FIX=PASS')
print('INTEGRATED_HANDOFF_POLL_FIX=PASS')
