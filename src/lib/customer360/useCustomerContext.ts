import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type SafeIdentity = Partial<Record<"name" | "email" | "phone", string>>;

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
  customerRef: null;
  createdAt: string | null;
  lastSeenAt: string | null;
  channelName: string | null;
  identity: SafeIdentity;
  conversations: CustomerContextConversation[];
  feedback: CustomerContextFeedback[];
  evaluations: CustomerContextEvaluation[];
  emotionPoints: CustomerContextEmotionPoint[];
};
export type CustomerContextErrorSource = "customer360_local" | "unexpected";

export type CustomerContextState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; source: CustomerContextErrorSource }
  | { status: "success"; data: CustomerContext };

export function useCustomerContext(visitorSessionId: string | null): CustomerContextState {
  const [state, setState] = useState<CustomerContextState>({ status: "idle" });
  const reqIdRef = useRef(0);

  useEffect(() => {
    const reqId = ++reqIdRef.current;
    let cancelled = false;
    const stale = () => cancelled || reqIdRef.current !== reqId;

    if (!visitorSessionId) {
      setState({ status: "idle" });
      return () => { cancelled = true; };
    }

    setState({ status: "loading" });

    void (async () => {
      try {
        const { data, error } = await supabase.functions.invoke("customer360-local", {
          body: { mode: "detail", visitor_session_id: visitorSessionId },
        });

        if (stale()) return;
        if (error || !data?.success) {
          if (data?.error === "not_found") {
            setState({ status: "empty" });
            return;
          }
          setState({ status: "error", source: "customer360_local" });
          return;
        }

        const customer = data.customer as Record<string, unknown>;
        setState({
          status: "success",
          data: {
            visitorSessionId: String(customer.visitor_session_id),
            customerRef: null,
            createdAt: typeof customer.created_at === "string" ? customer.created_at : null,
            lastSeenAt: typeof customer.last_seen_at === "string" ? customer.last_seen_at : null,
            channelName: typeof customer.channel_name === "string" ? customer.channel_name : null,
            identity: (customer.identity ?? {}) as SafeIdentity,
            conversations: (customer.conversations ?? []) as CustomerContextConversation[],
            feedback: (customer.feedback ?? []) as CustomerContextFeedback[],
            evaluations: (customer.evaluations ?? []) as CustomerContextEvaluation[],
            emotionPoints: (customer.emotion_points ?? []) as CustomerContextEmotionPoint[],
          },
        });
      } catch {
        if (!stale()) setState({ status: "error", source: "unexpected" });
      }
    })();

    return () => { cancelled = true; };
  }, [visitorSessionId]);

  return state;
}
