import { useEffect, useReducer, useRef, type SetStateAction } from "react";
import { supabase } from "@/integrations/supabase/client";

type Draft = { text: string; revision: number };
type Pending = { requestId: string; agentId: string; phase: "sending" | "unknown"; draft?: Draft };
type ReceiptMessage = { role: string; sender_id?: string | null; metadata: unknown };
const PREFIX = "c3:agent-reply:pending:";

/** Drafts are actor/ticket scoped in this tab. The separate recovery journal stores only IDs/revision. */
export function useTicketReply(actorId: string | undefined, conversationId: string | null, agentId: string | undefined, messages: ReceiptMessage[]) {
  const [, render] = useReducer((n: number) => n + 1, 0);
  const drafts = useRef(new Map<string, Draft>());
  const pending = useRef(new Map<string, Pending>());
  const notices = useRef(new Map<string, string>());
  const key = actorId && conversationId ? JSON.stringify([actorId, conversationId]) : "";
  const current = useRef(key); current.current = key;
  useEffect(() => { current.current = key; return () => { current.current = ""; }; }, [key]);
  const storageKey = (scope: string) => PREFIX + scope;
  const draftKey = (scope: string) => "c3:agent-reply:draft:" + scope;
  const getDraft = (scope: string): Draft => drafts.current.get(scope) ?? { text: "", revision: 0 };
  const setReply = (value: SetStateAction<string>) => {
    if (!key) return;
    const before = getDraft(key), text = typeof value === "function" ? value(before.text) : value;
    if (text !== before.text) {
      const next = { text, revision: before.revision + 1 };
      drafts.current.set(key, next);
      try { sessionStorage.setItem(draftKey(key), JSON.stringify(next)); }
      catch { notices.current.set(key, "Draft retained in this view; tab persistence unavailable. Sending is paused."); }
    }
    render();
  };
  function settle(scope: string, operation: Pending) {
    // Never delete a successor journal entry or clear a newly edited draft.
    const draft = getDraft(scope);
    const unchanged = operation.draft && draft.revision === operation.draft.revision && draft.text === operation.draft.text;
    try {
      const stored = sessionStorage.getItem(storageKey(scope));
      if (stored && JSON.parse(stored).requestId !== operation.requestId) return false;
      if (unchanged) sessionStorage.setItem(draftKey(scope), JSON.stringify({ text: "", revision: draft.revision + 1 }));
      sessionStorage.removeItem(storageKey(scope));
    } catch { notices.current.set(scope, "Reply saved; recovery journal could not be cleared. Check history before further action."); return false; }
    if (unchanged) drafts.current.set(scope, { text: "", revision: draft.revision + 1 });
    pending.current.delete(scope);
    notices.current.delete(scope);
    return true;
  }
  useEffect(() => {
    if (!key) return;
    let changed = false;
    if (!drafts.current.has(key)) {
      try {
        const stored = sessionStorage.getItem(draftKey(key));
        if (stored) {
          const v = JSON.parse(stored);
          if (typeof v.text !== "string" || !Number.isSafeInteger(v.revision) || v.revision < 0) throw Error("invalid draft");
          drafts.current.set(key, v); changed = true;
        }
      } catch { if (!notices.current.has(key)) { notices.current.set(key, "Draft storage unavailable. Sending is paused; check ticket history."); changed = true; } }
    }
    if (!pending.current.has(key)) {
      try {
        const stored = sessionStorage.getItem(storageKey(key));
        if (stored) {
          const v = JSON.parse(stored);
          if (typeof v.requestId !== "string" || typeof v.agentId !== "string") throw Error("invalid journal");
          pending.current.set(key, { requestId: v.requestId, agentId: v.agentId, phase: "unknown", draft: getDraft(key).revision === v.draftRevision ? { ...getDraft(key) } : undefined }); changed = true;
        }
      } catch { if (!notices.current.has(key)) { notices.current.set(key, "Reply recovery journal unavailable. Sending is paused; check ticket history."); changed = true; } }
    }
    const operation = pending.current.get(key);
    if (operation && messages.some(m => {
      const metadata = m.metadata as Record<string, unknown> | null;
      return m.role === "agent" && m.sender_id === operation.agentId && metadata?.control_commit === "human" && metadata?.client_request_id === operation.requestId;
    })) changed = settle(key, operation) || changed;
    if (changed) render();
  }, [key, messages]);
  async function send(before?: (ticketId: string) => Promise<boolean>) {
    const scope = key, ticket = conversationId, captured = { ...getDraft(scope) };
    if (!scope || current.current !== scope || !ticket || !agentId || !captured.text.trim() || pending.current.has(scope) || notices.current.has(scope)) return false;
    const operation: Pending = { requestId: crypto.randomUUID(), agentId, phase: "sending", draft: captured };
    // Refuse an existing/unknown fence before a control operation; never overwrite it.
    try {
      if (sessionStorage.getItem(storageKey(scope))) { notices.current.set(scope, "An earlier reply outcome is unconfirmed. Check ticket history."); render(); return false; }
    } catch { notices.current.set(scope, "Reply recovery journal unavailable. Reply not submitted."); render(); return false; }
    pending.current.set(scope, operation); render();
    let journalSaved = false;
    try {
      if (before && (!(await before(ticket)) || current.current !== scope)) {
        // No agent-send-reply call was made. Preserve the draft and remove only this fence.
        pending.current.delete(scope); return false;
      }
      // Persist only after control confirmation and immediately before the reply request.
      // Reload/unmount during Take Over cannot submit a later reply from this instance.
      if (sessionStorage.getItem(storageKey(scope))) throw Error("journal successor");
      const savedDraft = JSON.stringify(getDraft(scope));
      sessionStorage.setItem(draftKey(scope), savedDraft);
      if (sessionStorage.getItem(draftKey(scope)) !== savedDraft) throw Error("draft not saved");
      const journal = JSON.stringify({ requestId: operation.requestId, agentId, draftRevision: captured.revision });
      sessionStorage.setItem(storageKey(scope), journal);
      if (sessionStorage.getItem(storageKey(scope)) !== journal) throw Error("journal not saved");
      journalSaved = true;
      const { data, error } = await supabase.functions.invoke("agent-send-reply", { body: { conversation_id: ticket, content: captured.text.trim(), client_request_id: operation.requestId } });
      if (pending.current.get(scope) !== operation) return true;
      if (!error && data?.success === true && typeof data.data?.message_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.data.message_id)) {
        if (!settle(scope, operation)) { operation.phase = "unknown"; notices.current.set(scope, "Reply saved; recovery journal changed. Check history before further action."); }
        return true;
      }
      // Auth/validation denials are definitive; a 5xx, malformed receipt or transport failure is not.
      const status = error?.context instanceof Response ? error.context.status : null;
      if ([400,401,403,404,409,422].includes(status ?? 0)) {
        const stored = sessionStorage.getItem(storageKey(scope));
        if (stored && JSON.parse(stored).requestId === operation.requestId) sessionStorage.removeItem(storageKey(scope));
        pending.current.delete(scope);
        notices.current.set(scope, "Reply rejected. Draft retained; refresh the ticket before another attempt.");
        return false;
      }
      operation.phase = "unknown";
      notices.current.set(scope, "Reply outcome unconfirmed. Draft retained; no resend. Check reply status.");
      return false;
    } catch {
      if (pending.current.get(scope) !== operation) return true;
      if (!journalSaved) { pending.current.delete(scope); notices.current.set(scope, "Reply recovery journal unavailable or changed. Reply not submitted."); return false; }
      operation.phase = "unknown";
      notices.current.set(scope, "Reply outcome unconfirmed. Draft retained; no resend. Check reply status.");
      return false;
    } finally { render(); }
  }
  const checked = () => { if (!pending.current.has(key)) { notices.current.delete(key); render(); } };
  return { checked, reply: getDraft(key).text, setReply, send, sending: pending.current.get(key)?.phase === "sending", blocked: pending.current.has(key) || notices.current.has(key), notice: notices.current.get(key) ?? (pending.current.has(key) ? "Reply outcome unconfirmed. Check reply status." : "") };
}
