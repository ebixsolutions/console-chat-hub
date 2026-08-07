// src/lib/customer360/useCustomerContext.ts
//
// ONE canonical local Customer context loader, shared by:
//  - standalone Customer 360 page (console.customer360.tsx)
//  - CRMPanel Customer tab (components/console/CRMPanel.tsx)
//
// Scope: real local Supabase data only, gated by existing RLS. Does NOT call
// the external customer360-adapter — that remains a separate, currently
// Gate-A-shell upstream enrichment layer (PR-1 Task 2 Round 2 ruling §7/§8).
//
// customer_ref: exhaustively searched (2026-08-07) — schema (all tables/views),
// all 23 Edge Functions, all src/customer360/* contract files, all src/lib/api/*
// services. NO authoritative mapping from visitor_session_id (or any other
// local identifier) to an external CRM customer identity exists anywhere in
// this repository. customerRef is therefore always `null`. Do NOT alias
// visitor_session_id as customer_ref — format validity (UUID) is not identity
// semantics (PR-1 Task 2 Round 1 Finding B).
//
// visitor_metadata privacy: create-visitor-session/index.ts always injects
// `origin` (page URL) and `user_agent` (browser fingerprint) into every row's
// visitor_metadata, and the production widget (chat.js) sends no other keys.
// This hook exposes ONLY an explicit allowlist of voluntary identity fields —
// never origin/user_agent/fingerprint/tokens/internal IDs.

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const SAFE_VISITOR_METADATA_KEYS = ["name", "email", "phone"] as const;
type SafeIdentityKey = (typeof SAFE_VISITOR_METADATA_KEYS)[number];
export type SafeIdentity = Partial<Record<SafeIdentityKey, string>>;

function extractSafeIdentity(meta: unknown): SafeIdentity {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const m = meta as Record<string, unknown>;
  const out: SafeIdentity = {};
  for (const k of SAFE_VISITOR_METADATA_KEYS) {
    const v = m[k];
    if (typeof v === "string" && v.trim().length > 0) out[k] = v.trim();
  }
  return out;
}

export type CustomerContextConversation = {
  id: string;
  status: string;
  priority: string | null;
  created_at: string | null;
  channel_name: string | null;
  assigned_agent_name: string | null;
};
export type CustomerContextFeedback = {
  conversation_id: string;
  rating: number | null;
  feedback_text: string | null;
  created_at: string;
};
export type CustomerContextEvaluation = {
  conversation_id: string;
  overall_score: number;
  severity: string;
  review_status: string;
  created_at: string;
};
export type CustomerContextEmotionPoint = {
  conversation_id: string;
  turn_index: number;
  sentiment: string;
  sentiment_score: number;
  occurred_at: string;
};
export type CustomerContext = {
  visitorSessionId: string;
  customerRef: null; // always unresolved — see file header
  createdAt: string | null;
  lastSeenAt: string | null;
  channelName: string | null;
  identity: SafeIdentity; // allowlist-filtered voluntary fields only
  conversations: CustomerContextConversation[];
  feedback: CustomerContextFeedback[];
  evaluations: CustomerContextEvaluation[];
  emotionPoints: CustomerContextEmotionPoint[];
};
export type CustomerContextErrorSource =
  | "visitor_session"
  | "conversations"
  | "agent_profile"
  | "feedback_request"
  | "conversation_evaluation"
  | "ce_emotion_point"
  | "unexpected";

export type CustomerContextState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; source: CustomerContextErrorSource }
  | { status: "success"; data: CustomerContext };

/**
 * Loads real local Customer context for one visitor session.
 * Stale-request safe: if visitorSessionId changes before a prior load
 * resolves, the prior result is discarded via a monotonic request-id guard
 * and never applied to state (prevents A→B stale overwrite).
 */
export function useCustomerContext(visitorSessionId: string | null): CustomerContextState {
  const [state, setState] = useState<CustomerContextState>({ status: "idle" });
  const reqIdRef = useRef(0);

  useEffect(() => {
    const reqId = ++reqIdRef.current;
    let cancelled = false;
    const stale = () => cancelled || reqIdRef.current !== reqId;

    if (!visitorSessionId) {
      setState({ status: "idle" });
      return () => {
        cancelled = true;
      };
    }

    setState({ status: "loading" });

    (async () => {
      try {
        const { data: visitor, error: visitorErr } = await supabase
          .from("visitor_session")
          .select("id, created_at, last_seen_at, visitor_metadata, channel_config:channel_config_id(name)")
          .eq("id", visitorSessionId)
          .maybeSingle();
        if (stale()) return;
        if (visitorErr) {
          setState({ status: "error", source: "visitor_session" });
          return;
        }
        if (!visitor) {
          setState({ status: "empty" });
          return;
        }

        const { data: convRows, error: convErr } = await supabase
          .from("conversations")
          .select("id, status, priority, created_at, channel_config:channel_config_id(name), assigned_agent_id")
          .eq("visitor_session_id", visitorSessionId)
          .order("created_at", { ascending: false });
        if (stale()) return;
        if (convErr) {
          setState({ status: "error", source: "conversations" });
          return;
        }

        const rows = (convRows ?? []) as Array<{
          id: string;
          status: string;
          priority: string | null;
          created_at: string | null;
          channel_config: { name: string } | null;
          assigned_agent_id: string | null;
        }>;
        const convIds = rows.map((r) => r.id);
        const agentIds = [...new Set(rows.filter((r) => r.assigned_agent_id).map((r) => r.assigned_agent_id as string))];

        const [agentsRes, fbRes, evalRes] = await Promise.all([
          agentIds.length > 0
            ? supabase.from("agent_profile").select("id, display_name").in("id", agentIds)
            : Promise.resolve({ data: [] as Array<{ id: string; display_name: string }>, error: null }),
          supabase
            .from("feedback_request")
            .select("conversation_id, rating, feedback_text, created_at")
            .eq("visitor_session_id", visitorSessionId),
          convIds.length > 0
            ? supabase
                .from("conversation_evaluation")
                .select("conversation_id, overall_score, severity, review_status, created_at, id")
                .in("conversation_id", convIds)
            : Promise.resolve({
                data: [] as Array<{
                  conversation_id: string;
                  overall_score: number;
                  severity: string;
                  review_status: string;
                  created_at: string;
                  id: string;
                }>,
                error: null,
              }),
        ]);
        if (stale()) return;
        if (agentsRes.error) {
          setState({ status: "error", source: "agent_profile" });
          return;
        }
        if (fbRes.error) {
          setState({ status: "error", source: "feedback_request" });
          return;
        }
        if (evalRes.error) {
          setState({ status: "error", source: "conversation_evaluation" });
          return;
        }

        const agentMap: Record<string, string> = {};
        (agentsRes.data ?? []).forEach((a) => {
          agentMap[a.id] = a.display_name;
        });

        const evalRows = (evalRes.data ?? []) as Array<{
          conversation_id: string;
          overall_score: number;
          severity: string;
          review_status: string;
          created_at: string;
          id: string;
        }>;
        const evalIds = evalRows.map((e) => e.id);

        let emotionPoints: CustomerContextEmotionPoint[] = [];
        if (evalIds.length > 0) {
          const { data: emoData, error: emoErr } = await supabase
            .from("ce_emotion_point")
            .select("evaluation_id, turn_index, sentiment, sentiment_score, occurred_at")
            .in("evaluation_id", evalIds)
            .order("turn_index", { ascending: true });
          if (stale()) return;
          if (emoErr) {
            setState({ status: "error", source: "ce_emotion_point" });
            return;
          }
          const evalToConv: Record<string, string> = {};
          evalRows.forEach((e) => {
            evalToConv[e.id] = e.conversation_id;
          });
          emotionPoints = (
            (emoData ?? []) as Array<{
              evaluation_id: string;
              turn_index: number;
              sentiment: string;
              sentiment_score: number;
              occurred_at: string;
            }>
          ).map((e) => ({
            conversation_id: evalToConv[e.evaluation_id] ?? "",
            turn_index: e.turn_index,
            sentiment: e.sentiment,
            sentiment_score: e.sentiment_score,
            occurred_at: e.occurred_at,
          }));
        }

        if (stale()) return;
        const context: CustomerContext = {
          visitorSessionId,
          customerRef: null,
          createdAt: visitor.created_at,
          lastSeenAt: visitor.last_seen_at,
          channelName: (visitor.channel_config as { name: string } | null)?.name ?? null,
          identity: extractSafeIdentity(visitor.visitor_metadata),
          conversations: rows.map((r) => ({
            id: r.id,
            status: r.status,
            priority: r.priority,
            created_at: r.created_at,
            channel_name: r.channel_config?.name ?? null,
            assigned_agent_name: r.assigned_agent_id ? (agentMap[r.assigned_agent_id] ?? null) : null,
          })),
          feedback: (fbRes.data ?? []) as CustomerContextFeedback[],
          evaluations: evalRows.map((e) => ({
            conversation_id: e.conversation_id,
            overall_score: e.overall_score,
            severity: e.severity,
            review_status: e.review_status,
            created_at: e.created_at,
          })),
          emotionPoints,
        };
        setState({ status: "success", data: context });
      } catch {
        if (!stale()) setState({ status: "error", source: "unexpected" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visitorSessionId]);

  return state;
}
