import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { supabase } from "@/integrations/supabase/client";
import { Search, BookOpen, AlertCircle, Loader2, ShieldAlert } from "lucide-react";

export const Route = createFileRoute("/_authenticated/console/kb-gaps")({
  component: KbGapsGuard,
});

/* ── Bilingual copy ── */
const COPY = {
  title: { en: "Knowledge Helper", zh: "知識庫搜尋" },
  subtitle: {
    en: "Search the Knowledge Base for relevant articles and documents",
    zh: "搜尋知識庫中的相關文章與文件",
  },
  placeholder: { en: "Enter your search query...", zh: "輸入搜尋關鍵字..." },
  search: { en: "Search", zh: "搜尋" },
  searching: { en: "Searching...", zh: "搜尋中..." },
  noResults: { en: "No results found", zh: "未找到相關結果" },
  noResultsSub: {
    en: "Try different keywords or broaden your search",
    zh: "請嘗試不同的關鍵字或擴大搜尋範圍",
  },
  error: { en: "Search failed", zh: "搜尋失敗" },
  errorSub: {
    en: "Unable to connect to Knowledge Base. Please try again later.",
    zh: "無法連接知識庫，請稍後再試。",
  },
  configMissing: { en: "Knowledge Base not configured", zh: "知識庫尚未設定" },
  configMissingSub: {
    en: "KB environment is not set up. Contact your administrator.",
    zh: "KB 環境尚未設定，請聯繫管理員。",
  },
  accessDenied: { en: "Access denied", zh: "存取被拒" },
  accessDeniedSub: {
    en: "You do not have permission to search the Knowledge Base.",
    zh: "您沒有搜尋知識庫的權限。",
  },
  score: { en: "Relevance", zh: "相關度" },
  source: { en: "Source", zh: "來源" },
} as const;

type CopyKey = keyof typeof COPY;
type SearchStatus = "idle" | "searching" | "success" | "error" | "config_missing" | "access_denied";

/* ── Guard component: useCurrentRole() only ── */
function KbGapsGuard() {
  const { role, loading } = useCurrentRole();

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh" }}>
        <Loader2 size={24} className="animate-spin" style={{ color: "#888" }} />
      </div>
    );
  }

  if (!role || (role !== "admin" && role !== "supervisor")) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "60vh",
          gap: 12,
        }}
      >
        <AlertCircle size={40} style={{ color: "#ef4444" }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: "#374151" }}>
          Permission Denied / 權限不足
        </div>
        <div
          style={{
            fontSize: 12,
            color: "#9ca3af",
            textAlign: "center",
            maxWidth: 360,
            lineHeight: 1.6,
          }}
        >
          Only Admin and Supervisor roles can access Knowledge Helper.
          <br />
          僅限 Admin 和 Supervisor 角色存取知識庫搜尋。
        </div>
      </div>
    );
  }

  return <KbGapsContent />;
}

/* ── Error code extractor: 3-strategy fallback ── */
async function extractErrorCode(error: unknown): Promise<string> {
  // Strategy 1: Parse error.message as JSON (FunctionsHttpError stores body text as message)
  try {
    const msg = (error as { message?: string })?.message;
    if (msg) {
      const parsed = JSON.parse(msg);
      if (typeof parsed?.error === "string") return parsed.error;
    }
  } catch {
    /* not JSON */
  }

  // Strategy 2: Try error.context?.json() (Response object, if body not yet consumed)
  try {
    const ctx = (error as { context?: { json?: () => Promise<unknown> } })?.context;
    if (ctx && typeof ctx.json === "function") {
      const body = (await ctx.json()) as { error?: string };
      if (typeof body?.error === "string") return body.error;
    }
  } catch {
    /* context unavailable or body already consumed */
  }

  // Strategy 3: String matching fallback
  const raw = String((error as { message?: string })?.message || error || "");
  const known = [
    "kb_config_missing",
    "kb_api_error",
    "kb_api_timeout",
    "forbidden",
    "unauthorized",
    "invalid_request",
  ];
  for (const code of known) {
    if (raw.includes(code)) return code;
  }

  return "unknown";
}

/* ── Strict result shape validator (v1.1.2) ── */
interface SafeResult {
  display_label: string;
  content: string;
  score: number;
  source_type: string;
}

function validateResults(raw: unknown): SafeResult[] | null {
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const obj = item as Record<string, unknown>;
    if (typeof obj.display_label !== "string") return null;
    if (typeof obj.content !== "string") return null;
    if (typeof obj.score !== "number" || !Number.isFinite(obj.score)) return null;
    if (typeof obj.source_type !== "string") return null;
  }
  return (raw as SafeResult[]).map((r) => ({
    display_label: r.display_label,
    content: r.content,
    score: r.score,
    source_type: r.source_type,
  }));
}

/* ── Content component: all hooks and data fetching ── */
function KbGapsContent() {
  const lang = useConsoleLang();
  const t = (key: CopyKey) => COPY[key]?.[lang] ?? COPY[key]?.en ?? key;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SafeResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");

  const handleSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed || status === "searching") return;

    setStatus("searching");
    setResults([]);

    try {
      const { data, error } = await supabase.functions.invoke("kb-search-proxy", {
        body: { query: trimmed, top_k: 3 },
      });

      /* ── Error path: extract code safely ── */
      if (error) {
        const code = await extractErrorCode(error);
        switch (code) {
          case "kb_config_missing":
            setStatus("config_missing");
            break;
          case "forbidden":
          case "unauthorized":
            setStatus("access_denied");
            break;
          default:
            setStatus("error");
            break;
        }
        return;
      }

      /* ── Success path: validate shape ── */
      if (
        data &&
        typeof data === "object" &&
        data.success === true &&
        Array.isArray(data.results)
      ) {
        const safe = validateResults(data.results);
        if (safe) {
          setResults(safe);
          setStatus("success");
        } else {
          setStatus("error");
        }
      } else if (data && typeof data === "object" && data.error === "kb_config_missing") {
        setStatus("config_missing");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px" }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <BookOpen size={22} style={{ color: "#6366f1" }} />
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#1a1a1a", margin: 0 }}>
            {t("title")}
          </h1>
        </div>
        <p style={{ fontSize: 13, color: "#888", margin: 0 }}>{t("subtitle")}</p>
      </div>

      {/* Search bar */}
      <div style={{ display: "flex", gap: 8,