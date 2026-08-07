// ===========================================================================
// Dev22-G: Feedback Responses Management View
// Route: /console/feedback-responses
//
// Data: supabase.from("feedback_request") with MVP-minimum literal select.
// RLS-enforced. No mock data, EF, or server function.
//
// Timezone: UTC. dateFrom → .gte(startOfDayUtc). dateTo → .lt(nextDayUtc).
//
// Security:
// - MVP-minimum columns only (data minimization, defense in depth).
// - response_token_hash excluded: auth-related security material, no UI use.
// - recipient_email excluded: PII, no MVP need.
// - feedback_text: React escaped plain text, no dangerouslySetInnerHTML.
// - UI error: fixed safe string only. No raw Supabase errors in console.
// - Role guard: explicit fail-closed (admin | supervisor | agent only).
//
// Language: useConsoleLang() reads lang from existing EffectiveRoleContext.
// Role: useEffectiveRole() (unchanged return shape, role/loading only).
// Dates: toLocaleString with zh-HK / en-US matching Console lang.
//
// Stale-request protection: requestSeqRef ensures only the latest async
// query may update component state. Rapid filter changes cannot cause
// older responses to overwrite newer results.
//
// No TanStack Router outlet context. Plain <Outlet />.
// Demo Role Switcher changes UI only, not auth.uid() or user_roles.role.
// ===========================================================================

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useCallback, useRef } from "react";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/console/feedback-responses")({
  component: FeedbackResponsesPage,
});

const PAGE_SIZE = 20;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim());
}

function isDateRangeValid(from: string, to: string): boolean {
  return !(from && to && from > to);
}

function startOfDayUtc(dateStr: string): string {
  return `${dateStr}T00:00:00.000Z`;
}

function startOfNextDayUtc(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

// ── Bilingual copy (Blocker 1 fix: CopyBlock = Record<CopyKey, string>) ──

const EN_COPY = {
  filterStatus: "Status",
  filterDelivery: "Delivery",
  filterChannel: "Channel",
  filterRating: "Rating",
  filterFrom: "From",
  filterTo: "To",
  filterConvId: "Conversation ID",
  searchBtn: "Search",
  clearBtn: "Clear",
  retryBtn: "Retry",
  loadError: "Unable to load feedback responses. Please try again.",
  emptyTitle: "No feedback responses found",
  emptyFilterHint: "Try adjusting your filters.",
  emptyDefaultHint: "Feedback responses will appear here once customers submit ratings.",
  permissionDenied: "You do not have permission to view feedback responses.",
  showing: "Showing",
  of: "of",
  prev: "\u2190 Prev",
  next: "Next \u2192",
  statusAll: "All",
  statusPending: "Pending",
  statusResponded: "Responded",
  deliveryAll: "All",
  deliveryPending: "Pending",
  deliverySent: "Sent",
  deliveryFailed: "Failed",
  channelAll: "All",
  channelEmail: "Email",
  channelWidget: "Widget",
  ratingAll: "All",
  ratingNone: "No Rating",
  uuidPlaceholder: "Enter full UUID\u2026",
  uuidInvalid: "Please enter a valid UUID.",
  uuidStaleWarning: "Invalid UUID. The previous search remains active.",
  dateRangeInvalid: "\u201CFrom\u201D date must not be after \u201CTo\u201D date.",
  colId: "ID",
  colConversation: "Conversation",
  colChannel: "Channel",
  colStatus: "Status",
  colDelivery: "Delivery",
  colRating: "Rating",
  colFeedback: "Feedback",
  colResponded: "Responded",
  colCreated: "Created",
  expandMore: "more",
  expandLess: "less",
  noValue: "\u2014",
} as const;

type CopyKey = keyof typeof EN_COPY;
type CopyBlock = Record<CopyKey, string>;

const COPY: Record<"en" | "zh", CopyBlock> = {
  en: EN_COPY,
  zh: {
    filterStatus: "\u72C0\u614B",
    filterDelivery: "\u767C\u9001\u72C0\u614B",
    filterChannel: "\u6E20\u9053",
    filterRating: "\u8A55\u5206",
    filterFrom: "\u958B\u59CB\u65E5\u671F",
    filterTo: "\u7D50\u675F\u65E5\u671F",
    filterConvId: "\u5C0D\u8A71 ID",
    searchBtn: "\u641C\u5C0B",
    clearBtn: "\u6E05\u9664",
    retryBtn: "\u91CD\u8A66",
    loadError: "\u7121\u6CD5\u8F09\u5165\u56DE\u994B\u8CC7\u6599\uFF0C\u8ACB\u91CD\u8A66\u3002",
    emptyTitle: "\u672A\u627E\u5230\u7B26\u5408\u689D\u4EF6\u7684\u56DE\u994B",
    emptyFilterHint: "\u8ACB\u5617\u8A66\u8ABF\u6574\u7BE9\u9078\u689D\u4EF6\u3002",
    emptyDefaultHint:
      "\u5BA2\u6236\u63D0\u4EA4\u8A55\u5206\u5F8C\uFF0C\u56DE\u994B\u8CC7\u6599\u5C07\u986F\u793A\u5728\u6B64\u9801\u9762\u3002",
    permissionDenied: "\u60A8\u6C92\u6709\u6B0A\u9650\u67E5\u770B\u5BA2\u6236\u56DE\u994B\u3002",
    showing: "\u986F\u793A",
    of: "\u5171",
    prev: "\u2190 \u4E0A\u4E00\u9801",
    next: "\u4E0B\u4E00\u9801 \u2192",
    statusAll: "\u5168\u90E8",
    statusPending: "\u5F85\u56DE\u8986",
    statusResponded: "\u5DF2\u56DE\u8986",
    deliveryAll: "\u5168\u90E8",
    deliveryPending: "\u5F85\u767C\u9001",
    deliverySent: "\u5DF2\u767C\u9001",
    deliveryFailed: "\u5931\u6557",
    channelAll: "\u5168\u90E8",
    channelEmail: "Email",
    channelWidget: "Widget",
    ratingAll: "\u5168\u90E8",
    ratingNone: "\u7121\u8A55\u5206",
    uuidPlaceholder: "\u8F38\u5165\u5B8C\u6574 UUID\u2026",
    uuidInvalid: "\u8ACB\u8F38\u5165\u6709\u6548\u7684 UUID\u3002",
    uuidStaleWarning: "\u7121\u6548 UUID\u3002\u76EE\u524D\u641C\u5C0B\u4ECD\u70BA\u4E0A\u4E00\u6B21\u7D50\u679C\u3002",
    dateRangeInvalid:
      "\u300C\u958B\u59CB\u65E5\u671F\u300D\u4E0D\u53EF\u665A\u65BC\u300C\u7D50\u675F\u65E5\u671F\u300D\u3002",
    colId: "ID",
    colConversation: "\u5C0D\u8A71",
    colChannel: "\u6E20\u9053",
    colStatus: "\u72C0\u614B",
    colDelivery: "\u767C\u9001",
    colRating: "\u8A55\u5206",
    colFeedback: "\u56DE\u994B\u5167\u5BB9",
    colResponded: "\u56DE\u8986\u6642\u9593",
    colCreated: "\u5EFA\u7ACB\u6642\u9593",
    expandMore: "\u5C55\u958B",
    expandLess: "\u6536\u8D77",
    noValue: "\u2014",
  },
};

function useCopy(): CopyBlock {
  const lang = useConsoleLang();
  return COPY[lang];
}

// ── Row type ──

type FeedbackRow = {
  id: string;
  conversation_id: string;
  channel: string | null;
  status: string | null;
  rating: number | null;
  feedback_text: string | null;
  responded_at: string | null;
  delivery_status: string | null;
  created_at: string;
};

// ── UUID error code (Correction 2: stored as code, rendered at display) ──

type ConvIdErrorCode = "invalid" | "stale" | null;

// ── Date formatting ──

function useLocaleFormatter(): (iso: string | null) => string {
  const lang = useConsoleLang();
  const locale = lang === "zh" ? "zh-HK" : "en-US";
  return (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale) : "");
}

// ── Inline styles ──

const cardStyle: React.CSSProperties = {
  background: "#fff",
  border: "0.5px solid #e8e6e0",
  borderRadius: 11,
  padding: 14,
  marginBottom: 12,
};
const selectStyle: React.CSSProperties = {
  fontSize: 11.5,
  padding: "5px 8px",
  border: "0.5px solid #e8e6e0",
  borderRadius: 7,
  background: "#fff",
  color: "#1a1a1a",
};
const inputStyle: React.CSSProperties = {
  fontSize: 11.5,
  padding: "5px 8px",
  border: "0.5px solid #e8e6e0",
  borderRadius: 7,
  background: "#fff",
  color: "#1a1a1a",
  boxSizing: "border-box" as const,
};
const thStyle: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: "#888",
  textTransform: "uppercase" as const,
  padding: "6px 8px",
  textAlign: "left" as const,
  borderBottom: "0.5px solid #e8e6e0",
  whiteSpace: "nowrap" as const,
};
const tdStyle: React.CSSProperties = {
  fontSize: 11.5,
  padding: "8px 8px",
  borderBottom: "0.5px solid #f0efe9",
  verticalAlign: "top" as const,
};

// ── Sub-components ──

function RatingStars({ rating, noValue }: { rating: number | null; noValue: string }) {
  if (rating == null) return <span style={{ color: "#ccc", fontSize: 11 }}>{noValue}</span>;
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    stars.push(
      <span key={i} style={{ color: i <= rating ? "#f59e0b" : "#e5e7eb", fontSize: 13 }}>
        {"\u2605"}
      </span>,
    );
  }
  return <span>{stars}</span>;
}

function StatusBadge({ value, label, noValue }: { value: string | null; label: string; noValue: string }) {
  if (!value) return <span style={{ color: "#ccc", fontSize: 11 }}>{noValue}</span>;
  const colorMap: Record<string, { bg: string; color: string }> = {
    pending: { bg: "#fef3c7", color: "#92400e" },
    responded: { bg: "#dcfce7", color: "#166534" },
    sent: { bg: "#dbeafe", color: "#1e40af" },
    delivery_failed: { bg: "#fef2f2", color: "#991b1b" },
  };
  const c = colorMap[value] || { bg: "#f0efe9", color: "#555" };
  return (
    <span
      style={{
        background: c.bg,
        color: c.color,
        fontSize: 10,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 20,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function FeedbackTextCell({
  text,
  moreLabel,
  lessLabel,
}: {
  text: string | null;
  moreLabel: string;
  lessLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return <span style={{ color: "#ccc", fontSize: 11 }}>{"\u2014"}</span>;
  const truncated = text.length > 80 ? text.slice(0, 80) + "\u2026" : text;
  if (!expanded) {
    return (
      <span>
        <span style={{ fontSize: 11.5, color: "#555" }}>{truncated}</span>
        {text.length > 80 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-expanded={false}
            style={{
              background: "none",
              border: "none",
              color: "#2563eb",
              fontSize: 10,
              cursor: "pointer",
              marginLeft: 4,
              padding: 0,
              textDecoration: "underline",
            }}
          >
            {moreLabel}
          </button>
        )}
      </span>
    );
  }
  return (
    <div>
      <div
        style={{
          fontSize: 11.5,
          color: "#555",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 120,
          overflowY: "auto",
          background: "#f9f9f7",
          padding: "6px 8px",
          borderRadius: 6,
          border: "0.5px solid #e8e6e0",
        }}
      >
        {text}
      </div>
      <button
        type="button"
        onClick={() => setExpanded(false)}
        aria-expanded={true}
        style={{
          background: "none",
          border: "none",
          color: "#2563eb",
          fontSize: 10,
          cursor: "pointer",
          marginTop: 2,
          padding: 0,
          textDecoration: "underline",
        }}
      >
        {lessLabel}
      </button>
    </div>
  );
}

// ── Main ──

function FeedbackResponsesPage() {
  const { role: productionRole, loading: roleLoading } = useCurrentRole();
  const copy = useCopy();

  if (roleLoading) return <LoadingState />;

  // Authorization uses production DB role only (defense in depth).
  // Demo Role Switcher may affect UI display but cannot grant access.
  const canView = productionRole === "admin" || productionRole === "supervisor" || productionRole === "agent";

  if (!canView) return <PermissionDenied message={copy.permissionDenied} />;

  return <FeedbackResponsesContent />;
}

function FeedbackResponsesContent() {
  const copy = useCopy();
  const fmtDate = useLocaleFormatter();

  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [page, setPage] = useState(0);

  const [filterStatus, setFilterStatus] = useState("");
  const [filterDeliveryStatus, setFilterDeliveryStatus] = useState("");
  const [filterChannel, setFilterChannel] = useState("");
  const [filterRating, setFilterRating] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [convIdInput, setConvIdInput] = useState("");
  const [convIdError, setConvIdError] = useState<ConvIdErrorCode>(null);
  const [activeConvFilter, setActiveConvFilter] = useState("");

  // Stale-request protection (Correction 3)
  const requestSeqRef = useRef(0);

  const dateRangeValid = isDateRangeValid(dateFrom, dateTo);

  const statusLabels: Record<string, string> = {
    pending: copy.statusPending,
    responded: copy.statusResponded,
  };
  const deliveryLabels: Record<string, string> = {
    pending: copy.deliveryPending,
    sent: copy.deliverySent,
    delivery_failed: copy.deliveryFailed,
  };
  const channelLabels: Record<string, string> = {
    email: copy.channelEmail,
    website_widget: copy.channelWidget,
  };

  const loadData = useCallback(async () => {
    if (!dateRangeValid) {
      requestSeqRef.current += 1;
      setLoading(false);
      setHasError(false);
      return;
    }

    const seq = ++requestSeqRef.current;

    setLoading(true);
    setHasError(false);

    try {
      let query = supabase
        .from("feedback_request")
        .select("id,conversation_id,channel,status,rating,feedback_text,responded_at,delivery_status,created_at", {
          count: "exact",
        });

      if (filterStatus) query = query.eq("status", filterStatus);
      if (filterDeliveryStatus) query = query.eq("delivery_status", filterDeliveryStatus);
      if (filterChannel) query = query.eq("channel", filterChannel);
      if (filterRating) {
        if (filterRating === "none") {
          query = query.is("rating", null);
        } else {
          query = query.eq("rating", Number(filterRating));
        }
      }
      if (activeConvFilter) query = query.eq("conversation_id", activeConvFilter);
      if (dateFrom) query = query.gte("created_at", startOfDayUtc(dateFrom));
      if (dateTo) query = query.lt("created_at", startOfNextDayUtc(dateTo));

      query = query.order("created_at", { ascending: false });
      const offset = page * PAGE_SIZE;
      query = query.range(offset, offset + PAGE_SIZE - 1);

      const { data, error, count } = await query;

      if (seq !== requestSeqRef.current) return;

      if (error) {
        console.warn("[Dev22-G] feedback_request_load_failed");
        setHasError(true);
        setRows([]);
        setTotalCount(0);
        return;
      }

      setRows(data ?? []);
      setTotalCount(count ?? 0);
    } catch {
      if (seq !== requestSeqRef.current) return;
      console.warn("[Dev22-G] feedback_request_load_failed");
      setHasError(true);
      setRows([]);
      setTotalCount(0);
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [
    filterStatus,
    filterDeliveryStatus,
    filterChannel,
    filterRating,
    activeConvFilter,
    dateFrom,
    dateTo,
    page,
    dateRangeValid,
  ]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleConvSearch = () => {
    const trimmed = convIdInput.trim();
    if (!trimmed) {
      setConvIdError(null);
      setActiveConvFilter("");
      setPage(0);
      return;
    }
    if (!isValidUuid(trimmed)) {
      setConvIdError(activeConvFilter ? "stale" : "invalid");
      return;
    }
    setConvIdError(null);
    setActiveConvFilter(trimmed);
    setPage(0);
  };

  const handleClearConvSearch = () => {
    setConvIdInput("");
    setConvIdError(null);
    setActiveConvFilter("");
    setPage(0);
  };

  const handleFilterChange =
    (setter: React.Dispatch<React.SetStateAction<string>>) =>
    (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => {
      setter(e.target.value);
      setPage(0);
    };

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const showFrom = totalCount === 0 ? 0 : page * PAGE_SIZE + 1;
  const showTo = Math.min((page + 1) * PAGE_SIZE, totalCount);
  const hasActiveFilters =
    activeConvFilter || filterStatus || filterDeliveryStatus || filterChannel || filterRating || dateFrom || dateTo;
  const showResults = dateRangeValid;

  // Render UUID error from code (Correction 2: language-sync safe)
  const convIdErrorText =
    convIdError === "stale" ? copy.uuidStaleWarning : convIdError === "invalid" ? copy.uuidInvalid : null;

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={cardStyle}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#888", marginBottom: 3 }}>{copy.filterStatus}</div>
            <select value={filterStatus} onChange={handleFilterChange(setFilterStatus)} style={selectStyle}>
              <option value="">{copy.statusAll}</option>
              <option value="pending">{copy.statusPending}</option>
              <option value="responded">{copy.statusResponded}</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#888", marginBottom: 3 }}>{copy.filterDelivery}</div>
            <select
              value={filterDeliveryStatus}
              onChange={handleFilterChange(setFilterDeliveryStatus)}
              style={selectStyle}
            >
              <option value="">{copy.deliveryAll}</option>
              <option value="pending">{copy.deliveryPending}</option>
              <option value="sent">{copy.deliverySent}</option>
              <option value="delivery_failed">{copy.deliveryFailed}</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#888", marginBottom: 3 }}>{copy.filterChannel}</div>
            <select value={filterChannel} onChange={handleFilterChange(setFilterChannel)} style={selectStyle}>
              <option value="">{copy.channelAll}</option>
              <option value="email">{copy.channelEmail}</option>
              <option value="website_widget">{copy.channelWidget}</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#888", marginBottom: 3 }}>{copy.filterRating}</div>
            <select value={filterRating} onChange={handleFilterChange(setFilterRating)} style={selectStyle}>
              <option value="">{copy.ratingAll}</option>
              <option value="1">1 {"\u2605"}</option>
              <option value="2">2 {"\u2605"}</option>
              <option value="3">3 {"\u2605"}</option>
              <option value="4">4 {"\u2605"}</option>
              <option value="5">5 {"\u2605"}</option>
              <option value="none">{copy.ratingNone}</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#888", marginBottom: 3 }}>{copy.filterFrom}</div>
            <input
              type="date"
              value={dateFrom}
              onChange={handleFilterChange(setDateFrom)}
              style={{ ...inputStyle, width: 130 }}
            />
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#888", marginBottom: 3 }}>{copy.filterTo}</div>
            <input
              type="date"
              value={dateTo}
              onChange={handleFilterChange(setDateTo)}
              style={{ ...inputStyle, width: 130 }}
            />
          </div>
        </div>

        {!dateRangeValid && <div style={{ marginTop: 6, fontSize: 11, color: "#dc2626" }}>{copy.dateRangeInvalid}</div>}

        <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "#888", flexShrink: 0 }}>{copy.filterConvId}</div>
          <input
            type="text"
            value={convIdInput}
            onChange={(e) => {
              setConvIdInput(e.target.value);
              if (convIdError) setConvIdError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConvSearch();
            }}
            placeholder={copy.uuidPlaceholder}
            style={{ ...inputStyle, width: 300, fontFamily: "monospace", fontSize: 11 }}
          />
          <button
            type="button"
            onClick={handleConvSearch}
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "5px 12px",
              borderRadius: 7,
              border: "none",
              background: "#1a1a1a",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            {copy.searchBtn}
          </button>
          {activeConvFilter && (
            <button
              type="button"
              onClick={handleClearConvSearch}
              style={{
                fontSize: 11,
                padding: "5px 10px",
                borderRadius: 7,
                border: "0.5px solid #e8e6e0",
                background: "#fff",
                color: "#555",
                cursor: "pointer",
              }}
            >
              {copy.clearBtn}
            </button>
          )}
          {convIdErrorText && <span style={{ fontSize: 11, color: "#dc2626" }}>{convIdErrorText}</span>}
        </div>
      </div>

      {showResults && (
        <>
          {hasError && (
            <div
              style={{
                background: "#fef2f2",
                border: "0.5px solid #fca5a5",
                borderRadius: 11,
                padding: "12px 16px",
                marginBottom: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span style={{ fontSize: 12, color: "#991b1b" }}>
                {"\u274C"} {copy.loadError}
              </span>
              <button
                type="button"
                onClick={loadData}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "4px 12px",
                  borderRadius: 6,
                  border: "0.5px solid #fca5a5",
                  background: "#fff",
                  color: "#991b1b",
                  cursor: "pointer",
                }}
              >
                {copy.retryBtn}
              </button>
            </div>
          )}

          {loading && !hasError && <LoadingState />}

          {!loading && !hasError && rows.length === 0 && (
            <div style={{ ...cardStyle, textAlign: "center", padding: "40px 20px", color: "#888" }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>{"\uD83D\uDCCB"}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#555", marginBottom: 4 }}>{copy.emptyTitle}</div>
              <div style={{ fontSize: 11.5 }}>{hasActiveFilters ? copy.emptyFilterHint : copy.emptyDefaultHint}</div>
            </div>
          )}

          {!loading && !hasError && rows.length > 0 && (
            <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>{copy.colId}</th>
                      <th style={thStyle}>{copy.colConversation}</th>
                      <th style={thStyle}>{copy.colChannel}</th>
                      <th style={thStyle}>{copy.colStatus}</th>
                      <th style={thStyle}>{copy.colDelivery}</th>
                      <th style={thStyle}>{copy.colRating}</th>
                      <th style={thStyle}>{copy.colFeedback}</th>
                      <th style={thStyle}>{copy.colResponded}</th>
                      <th style={thStyle}>{copy.colCreated}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const channelLabel = row.channel ? (channelLabels[row.channel] ?? row.channel) : copy.noValue;
                      const statusLabel = row.status ? (statusLabels[row.status] ?? row.status) : copy.noValue;
                      const deliveryLabel = row.delivery_status
                        ? (deliveryLabels[row.delivery_status] ?? row.delivery_status)
                        : copy.noValue;

                      return (
                        <tr key={row.id}>
                          <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 10.5, color: "#888" }}>
                            {row.id.slice(0, 8)}
                            {"\u2026"}
                          </td>
                          <td style={tdStyle}>
                            <Link
                              to="/console/conversations/$id"
                              params={{ id: row.conversation_id }}
                              style={{
                                fontFamily: "monospace",
                                fontSize: 10.5,
                                color: "#2563eb",
                                textDecoration: "none",
                              }}
                            >
                              {row.conversation_id.slice(0, 8)}
                              {"\u2026"}
                            </Link>
                          </td>
                          <td style={tdStyle}>
                            <span style={{ fontSize: 11, color: "#555" }}>{channelLabel}</span>
                          </td>
                          <td style={tdStyle}>
                            <StatusBadge value={row.status} label={statusLabel} noValue={copy.noValue} />
                          </td>
                          <td style={tdStyle}>
                            <StatusBadge value={row.delivery_status} label={deliveryLabel} noValue={copy.noValue} />
                          </td>
                          <td style={tdStyle}>
                            <RatingStars rating={row.rating} noValue={copy.noValue} />
                          </td>
                          <td style={{ ...tdStyle, maxWidth: 220 }}>
                            <FeedbackTextCell
                              text={row.feedback_text}
                              moreLabel={copy.expandMore}
                              lessLabel={copy.expandLess}
                            />
                          </td>
                          <td style={{ ...tdStyle, fontSize: 11, color: "#555", whiteSpace: "nowrap" }}>
                            {row.responded_at ? fmtDate(row.responded_at) : copy.noValue}
                          </td>
                          <td style={{ ...tdStyle, fontSize: 11, color: "#888", whiteSpace: "nowrap" }}>
                            {fmtDate(row.created_at)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 14px",
                  borderTop: "0.5px solid #e8e6e0",
                  background: "#fafaf8",
                }}
              >
                <span style={{ fontSize: 11, color: "#888" }}>
                  {copy.showing} {showFrom}
                  {"\u2013"}
                  {showTo} {copy.of} {totalCount}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    style={{
                      fontSize: 11,
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "0.5px solid #e8e6e0",
                      background: page === 0 ? "#f5f4f0" : "#fff",
                      color: page === 0 ? "#ccc" : "#555",
                      cursor: page === 0 ? "default" : "pointer",
                    }}
                  >
                    {copy.prev}
                  </button>
                  <span
                    style={{ fontSize: 11, color: "#555", padding: "4px 8px", display: "flex", alignItems: "center" }}
                  >
                    {page + 1} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    style={{
                      fontSize: 11,
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "0.5px solid #e8e6e0",
                      background: page >= totalPages - 1 ? "#f5f4f0" : "#fff",
                      color: page >= totalPages - 1 ? "#ccc" : "#555",
                      cursor: page >= totalPages - 1 ? "default" : "pointer",
                    }}
                  >
                    {copy.next}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
