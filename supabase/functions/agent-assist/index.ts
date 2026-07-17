import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const TOOL_TYPES = new Set(["translate", "grammar", "suggest_reply", "check_policy"]);
const ELEVATED_ROLES = new Set(["admin", "supervisor"]);
const ALLOWED_LANGS = new Set(["en", "zh-TW"]);
const MAX_CONTENT = 2000;
const MAX_POLICY_ITEMS = 3;
const MAX_POLICY_CONTENT = 800;
const CLAUDE_TIMEOUT_MS = 15000;

const TOOL_ALLOWED_FIELDS: Record<string, Set<string>> = {
  translate: new Set(["tool_type", "conversation_id", "content", "target_language"]),
  grammar: new Set(["tool_type", "conversation_id", "content"]),
  suggest_reply: new Set(["tool_type", "conversation_id", "content"]),
  check_policy: new Set(["tool_type", "conversation_id", "content", "policy_context"]),
};
const POLICY_ITEM_KEYS = new Set(["label", "content", "source_type"]);
const VALID_TONES = new Set(["professional", "casual", "empathetic", "needs_improvement"]);
const VALID_SUG_TONES = new Set(["Empathetic", "Informative", "Neutral"]);
const VALID_POL_ST = new Set(["compliant", "warning", "violation", "insufficient_evidence"]);

const CONSOLE_ORIGINS = [
  "https://console-chat-hub.lovable.app",
  "https://id-preview--4dbf593e-577e-4af4-a553-460441c34473.lovable.app",
];

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": CONSOLE_ORIGINS.includes(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function jsonRes(body: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

async function callClaude(sys: string, usr: string): Promise<{ ok: boolean; text?: string }> {
  const k = Deno.env.get("ANTHROPIC_API_KEY");
  if (!k) {
    console.error("[agent-assist] AA_PROVIDER_KEY_UNAVAILABLE");
    return { ok: false };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CLAUDE_TIMEOUT_MS);
  let r: Response;
  try {
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": k, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 800,
          system: sys,
          messages: [{ role: "user", content: usr }],
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      console.error(
        "[agent-assist] AA_PROVIDER_FETCH_EXCEPTION",
        e instanceof Error && e.name === "AbortError" ? "AbortError" : "network_exception",
      );
      return { ok: false };
    }
    if (!r.ok) {
      console.error("[agent-assist] AA_PROVIDER_NON_2XX", r.status);
      return { ok: false };
    }
    let d: unknown;
    try {
      d = await r.json();
    } catch {
      console.error("[agent-assist] AA_PROVIDER_RESPONSE_PARSE_FAILED");
      return { ok: false };
    }
    const text =
      typeof d === "object" &&
      d !== null &&
      Array.isArray((d as { content?: unknown }).content) &&
      typeof (d as { content: Array<{ text?: unknown }> }).content[0]?.text === "string"
        ? (d as { content: Array<{ text: string }> }).content[0].text
        : "";
    if (!text) {
      console.error("[agent-assist] AA_PROVIDER_EMPTY_OUTPUT");
    }
    return { ok: true, text };
  } finally {
    clearTimeout(t);
  }
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      raw
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim(),
    );
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const o = req.headers.get("Origin") ?? "";
    if (!CONSOLE_ORIGINS.includes(o)) return new Response(null, { status: 403 });
    return new Response(null, { headers: getCorsHeaders(req) });
  }
  if (req.method !== "POST") return jsonRes({ error: "method_not_allowed" }, 405, req);
  const reqOrigin = req.headers.get("Origin");
  if (reqOrigin && !CONSOLE_ORIGINS.includes(reqOrigin)) {
    return new Response(JSON.stringify({ error: "forbidden_origin" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Auth layer 1: JWT
    const supabaseAuth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const {
      data: { user },
      error: authErr,
    } = await supabaseAuth.auth.getUser();
    if (authErr || !user) return jsonRes({ error: "unauthorized" }, 401, req);

    // Auth layer 2: roles
    const supabaseAdmin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: userRoles, error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    if (roleErr || !userRoles?.length) return jsonRes({ error: "forbidden" }, 403, req);

    // Multi-role: elevated priority
    const isElevated = userRoles.some((r: { role: string }) => ELEVATED_ROLES.has(r.role));
    const isAgent = userRoles.some((r: { role: string }) => r.role === "agent");
    if (!isElevated && !isAgent) return jsonRes({ error: "forbidden" }, 403, req);

    // Parse and validate body
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonRes({ error: "invalid_request", detail: "JSON body required" }, 400, req);
    }

    const toolType = body.tool_type;
    if (typeof toolType !== "string" || !TOOL_TYPES.has(toolType)) {
      return jsonRes({ error: "invalid_request", detail: "invalid tool_type" }, 400, req);
    }

    // Tool-specific field validation
    const allowedFields = TOOL_ALLOWED_FIELDS[toolType];
    for (const k of Object.keys(body)) {
      if (!allowedFields.has(k)) {
        return jsonRes({ error: "invalid_request", detail: `field '${k}' not allowed for ${toolType}` }, 400, req);
      }
    }

    const conversationId = body.conversation_id;
    if (!isUuid(conversationId)) {
      return jsonRes({ error: "invalid_request", detail: "invalid conversation_id" }, 400, req);
    }

    if (typeof body.content !== "string") {
      return jsonRes({ error: "invalid_request", detail: "content required" }, 400, req);
    }
    const content = body.content.trim();
    if (content.length < 1 || content.length > MAX_CONTENT) {
      return jsonRes({ error: "invalid_request", detail: "content 1-2000 chars" }, 400, req);
    }

    if (toolType === "translate") {
      if (!body.target_language || !ALLOWED_LANGS.has(body.target_language)) {
        return jsonRes({ error: "invalid_request", detail: "target_language required (en or zh-TW)" }, 400, req);
      }
    }

    // Policy context validation
    let policyContext: Array<{ label: string; content: string; source_type: string }> | null = null;
    if (toolType === "check_policy" && body.policy_context !== undefined) {
      if (!Array.isArray(body.policy_context) || body.policy_context.length > MAX_POLICY_ITEMS) {
        return jsonRes({ error: "invalid_request", detail: "policy_context max 3 items" }, 400, req);
      }
      policyContext = [];
      for (const p of body.policy_context) {
        if (!p || typeof p !== "object") {
          return jsonRes({ error: "invalid_request", detail: "invalid policy item" }, 400, req);
        }
        for (const pk of Object.keys(p)) {
          if (!POLICY_ITEM_KEYS.has(pk)) {
            return jsonRes({ error: "invalid_request", detail: "unknown policy field: " + pk }, 400, req);
          }
        }
        if (typeof p.label !== "string" || typeof p.content !== "string" || typeof p.source_type !== "string") {
          return jsonRes({ error: "invalid_request", detail: "policy items need string fields" }, 400, req);
        }
        const label = p.label.trim();
        const pc = p.content.trim();
        const st = p.source_type.trim();
        if (label.length < 1 || label.length > 120) {
          return jsonRes({ error: "invalid_request", detail: "policy label 1-120 chars" }, 400, req);
        }
        if (pc.length < 1 || pc.length > MAX_POLICY_CONTENT) {
          return jsonRes({ error: "invalid_request", detail: "policy content 1-800 chars" }, 400, req);
        }
        if (st.length < 1 || st.length > 40) {
          return jsonRes({ error: "invalid_request", detail: "policy source_type 1-40 chars" }, 400, req);
        }
        policyContext.push({ label, content: pc, source_type: st });
      }
    }

    // Conversation guard
    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, status, assigned_agent_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (convErr) return jsonRes({ error: "conversation_lookup_failed" }, 500, req);
    if (!conv) return jsonRes({ error: "conversation_not_found" }, 404, req);
    if (conv.status === "resolved") return jsonRes({ error: "conversation_resolved" }, 409, req);

    // Agent ownership guard (elevated bypasses)
    if (!isElevated) {
      const { data: ap, error: apErr } = await supabaseAdmin
        .from("agent_profile")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (apErr || !ap) {
        return jsonRes({ error: "forbidden", detail: "agent_profile_not_found" }, 403, req);
      }
      if (conv.assigned_agent_id !== ap.id) {
        return jsonRes({ error: "forbidden", detail: "not_assigned_to_conversation" }, 403, req);
      }
    }

    // Tool execution
    const targetLang = body.target_language as string | undefined;

    if (toolType === "translate") {
      const r = await callClaude(
        `Translate the text to ${targetLang === "zh-TW" ? "Traditional Chinese" : "English"}. Return ONLY JSON: {"translated_text":"...","source_language":"...","target_language":"${targetLang}"}`,
        content,
      );
      if (!r.ok || !r.text) return jsonRes({ success: false, error: "translate_failed" }, 502, req);
      const p = parseJson(r.text);
      if (!p || typeof p.translated_text !== "string" || !String(p.translated_text).trim()) {
        console.error("[agent-assist] AA_TRANSLATE_OUTPUT_INVALID");
        return jsonRes({ success: false, error: "translate_parse_failed" }, 502, req);
      }
      if (typeof p.source_language !== "string" || !String(p.source_language).trim()) {
        console.error("[agent-assist] AA_TRANSLATE_OUTPUT_INVALID");
        return jsonRes({ success: false, error: "translate_parse_failed" }, 502, req);
      }
      if (p.target_language !== targetLang) {
        console.error("[agent-assist] AA_TRANSLATE_OUTPUT_INVALID");
        return jsonRes({ success: false, error: "translate_parse_failed" }, 502, req);
      }
      return jsonRes(
        {
          success: true,
          tool_type: "translate",
          result: {
            translated_text: String(p.translated_text).slice(0, 2000),
            source_language: String(p.source_language).slice(0, 10),
            target_language: targetLang,
          },
        },
        200,
        req,
      );
    }

    if (toolType === "grammar") {
      const r = await callClaude(
        `Check grammar, spelling, and professional tone. Return ONLY JSON: {"corrected_text":"...","summary":"one sentence","tone_assessment":"professional|casual|empathetic|needs_improvement"}`,
        content,
      );
      if (!r.ok || !r.text) return jsonRes({ success: false, error: "grammar_failed" }, 502, req);
      const p = parseJson(r.text);
      if (!p || typeof p.corrected_text !== "string" || !String(p.corrected_text).trim()) {
        console.error("[agent-assist] AA_GRAMMAR_OUTPUT_INVALID");
        return jsonRes({ success: false, error: "grammar_parse_failed" }, 502, req);
      }
      if (typeof p.summary !== "string") {
        console.error("[agent-assist] AA_GRAMMAR_OUTPUT_INVALID");
        return jsonRes({ success: false, error: "grammar_parse_failed" }, 502, req);
      }
      if (!VALID_TONES.has(String(p.tone_assessment))) {
        console.error("[agent-assist] AA_GRAMMAR_OUTPUT_INVALID");
        return jsonRes({ success: false, error: "grammar_parse_failed" }, 502, req);
      }
      return jsonRes(
        {
          success: true,
          tool_type: "grammar",
          result: {
            corrected_text: String(p.corrected_text).slice(0, 2000),
            summary: String(p.summary).slice(0, 300),
            tone_assessment: String(p.tone_assessment),
          },
        },
        200,
        req,
      );
    }

    if (toolType === "suggest_reply") {
      const r = await callClaude(
        `Generate up to 3 customer service reply drafts with different tones. Return ONLY JSON: {"suggestions":[{"content":"...","tone_label":"Empathetic|Informative|Neutral"}]}. These are DRAFTS ONLY. Respond in the customer's language.`,
        content,
      );
      if (!r.ok || !r.text) return jsonRes({ success: false, error: "suggest_failed" }, 502, req);
      const p = parseJson(r.text);
      if (!p?.suggestions || !Array.isArray(p.suggestions)) {
        console.error("[agent-assist] AA_SUGGEST_OUTPUT_INVALID");
        return jsonRes({ success: false, error: "suggest_parse_failed" }, 502, req);
      }
      const safe = (p.suggestions as Array<Record<string, unknown>>)
        .filter(
          (s) =>
            typeof s.content === "string" &&
            String(s.content).trim().length > 0 &&
            VALID_SUG_TONES.has(String(s.tone_label)),
        )
        .slice(0, 3)
        .map((s) => ({ content: String(s.content).slice(0, 1000), tone_label: String(s.tone_label) }));
      if (safe.length === 0) {
        console.error("[agent-assist] AA_SUGGEST_OUTPUT_INVALID");
        return jsonRes({ success: false, error: "suggest_parse_failed" }, 502, req);
      }
      return jsonRes(
        { success: true, tool_type: "suggest_reply", draft_only: true, result: { suggestions: safe } },
        200,
        req,
      );
    }

    if (toolType === "check_policy") {
      if (!policyContext || policyContext.length === 0) {
        return jsonRes(
          {
            success: true,
            tool_type: "check_policy",
            result: {
              status: "insufficient_evidence",
              summary: "No policy sources provided. Cannot assess compliance without policy evidence.",
              issues: [],
            },
          },
          200,
          req,
        );
      }
      const block = policyContext.map((p) => `[${p.label}]\n${p.content}`).join("\n\n");
      const r = await callClaude(
        `Assess policy compliance based ONLY on the provided sources. Do NOT invent rules not in the sources. If sources lack relevant policy, set status to "insufficient_evidence". Return ONLY JSON: {"status":"compliant|warning|violation|insufficient_evidence","summary":"Based on provided policy sources, ...","issues":[{"excerpt":"...","policy_label":"...","severity":"warning|violation"}]}. Max 3 issues.`,
        `Text to check:\n${content}\n\nPolicy sources:\n${block}`,
      );
      if (!r.ok || !r.text) return jsonRes({ success: false, error: "policy_check_failed" }, 502, req);
      const p = parseJson(r.text);
      if (!p || typeof p.status !== "string") {
        return jsonRes({ success: false, error: "policy_parse_failed" }, 502, req);
      }
      if (!VALID_POL_ST.has(p.status)) {
        return jsonRes({ success: false, error: "policy_parse_failed" }, 502, req);
      }
      if (typeof p.summary !== "string" || !String(p.summary).trim()) {
        return jsonRes({ success: false, error: "policy_parse_failed" }, 502, req);
      }
      const issues = Array.isArray(p.issues)
        ? (p.issues as Array<Record<string, unknown>>)
            .filter(
              (i) =>
                typeof i.excerpt === "string" &&
                typeof i.policy_label === "string" &&
                (i.severity === "warning" || i.severity === "violation"),
            )
            .slice(0, 3)
            .map((i) => ({
              excerpt: String(i.excerpt).slice(0, 200),
              policy_label: String(i.policy_label).slice(0, 120),
              severity: String(i.severity),
            }))
        : [];
      if ((p.status === "warning" || p.status === "violation") && issues.length === 0) {
        return jsonRes({ success: false, error: "policy_parse_failed" }, 502, req);
      }
      return jsonRes(
        {
          success: true,
          tool_type: "check_policy",
          result: {
            status: p.status,
            summary: String(p.summary).slice(0, 500),
            issues,
          },
        },
        200,
        req,
      );
    }

    return jsonRes({ error: "invalid_request" }, 400, req);
  } catch (e) {
    console.error("[agent-assist] unexpected:", (e as Error).name);
    return jsonRes({ error: "internal_error" }, 500, req);
  }
});
