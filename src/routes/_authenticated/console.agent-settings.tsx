// ===========================================================================
// DEV22-I1: Agent Settings — Live Data Replacement v1.2.4
//
// File: src/routes/_authenticated/console.agent-settings.tsx
// Action: FULL FILE REPLACEMENT (paste entire content, overwrite existing)
//
// v1.2.3 → v1.2.4 changelog:
//   1. Schema: email + status (was availability_status — does not exist)
//   2. useConsoleLang: import from @/hooks/useEffectiveRole (was self-built)
//   3. useCurrentRole: destructure { role, loading } properly (was type cast)
//   4. LoadingState/PermissionDenied: import from PageStates (was inline)
//   5. Linked + no prod role: show legacy label with profile.role
//   6. Email displayed in UI
//   7. Status label = "Account status:" (uses verified `status` column)
//   8. Zero type assertions — no `as`, no `!` non-null assertions
//   9. All hooks called unconditionally at component top (React rules)
//  10. setUserRoles([]) on retry to prevent stale role badge display
//  11. roleError hides entire Admin role section (no false "No production role")
//  12. Unlinked profiles show legacy label (non-authoritative)
//  13. Removed unused linkedNoProdRole variable
//
// Scope:
//   - Guard: admin + supervisor → view; agent / roleless → PermissionDenied
//   - Data: live agent_profile from Supabase (no hardcoded mock)
//   - Admin: sees production role badges from user_roles
//   - Supervisor: no production role column (RLS: self-only)
//   - Bilingual: EN / 繁體中文 via useConsoleLang() from useEffectiveRole
//   - No Edit button (no CRUD backend in I1)
//   - No avatar_url in UI (column exists in schema but design excludes it)
//   - Status null → "Unknown" (not "active")
//
// Option A scope limitation:
//   UI access: admin + supervisor only
//   Underlying agent_profile SELECT RLS: staff (admin + supervisor + agent)
//   This task does NOT restrict agent API-level directory access
// ===========================================================================

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/console/agent-settings")({
  component: AgentSettingsGuard,
});

// ── Bilingual copy ──

type CopyBlock = {
  permissionDenied: string;
  loadError: string;
  retry: string;
  emptyTitle: string;
  emptyHint: string;
  supervisorBanner: string;
  roleQueryFailed: string;
  linked: string;
  unlinked: string;
  noProductionRole: string;
  multipleRoles: string;
  legacyDiffers: string;
  profileLabel: string;
  nonAuthoritative: string;
  accountStatus: string;
  statusUnknown: string;
  agentCount: (n: number) => string;
};

const COPY: Record<"en" | "zh", CopyBlock> = {
  en: {
    permissionDenied: "You do not have permission to view agent settings.",
    loadError: "Unable to load agent profiles. Please try again.",
    retry: "Retry",
    emptyTitle: "No agent profiles found",
    emptyHint: "Agent profiles will appear here once created in the system.",
    supervisorBanner:
      "You are viewing agent profiles as a Supervisor. Production role assignments are only visible to Admins.",
    roleQueryFailed: "Unable to load production roles.",
    linked: "Linked",
    unlinked: "Unlinked — no authenticated user",
    noProductionRole: "No production role assigned",
    multipleRoles: "Multiple roles",
    legacyDiffers: "Legacy profile role differs from production role — production role is authoritative",
    profileLabel: "Profile label (non-authoritative):",
    nonAuthoritative: "non-authoritative",
    accountStatus: "Account status:",
    statusUnknown: "Unknown",
    agentCount: (n: number) => `${n} agent${n === 1 ? "" : "s"}`,
  },
  zh: {
    permissionDenied: "您沒有權限查看客服設定。",
    loadError: "無法載入客服人員資料，請重試。",
    retry: "重試",
    emptyTitle: "尚無客服人員資料",
    emptyHint: "系統建立客服人員資料後將顯示於此。",
    supervisorBanner: "您正以 Supervisor 身份查看客服人員資料。正式角色指派僅 Admin 可見。",
    roleQueryFailed: "無法載入正式角色資料。",
    linked: "已連結",
    unlinked: "未連結 — 無對應認證帳號",
    noProductionRole: "尚未指派正式角色",
    multipleRoles: "多重角色",
    legacyDiffers: "舊版 profile 角色與正式角色不同 — 以正式角色為準",
    profileLabel: "Profile 標籤（僅供參考）：",
    nonAuthoritative: "僅供參考",
    accountStatus: "帳號狀態：",
    statusUnknown: "未知",
    agentCount: (n: number) => `${n} 位客服人員`,
  },
};

// ── Helpers ──

function formatStatus(status: string | null, unknownLabel: string): string {
  const value = status?.trim();
  if (!value) return unknownLabel;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

// ── Types (matches verified Supabase types.ts agent_profile Row) ──

interface AgentProfile {
  id: string;
  display_name: string;
  email: string;
  role: string;
  status: string | null;
  user_id: string | null;
}

interface UserRole {
  user_id: string;
  role: string;
}

// ── Guard component ──
// All hooks called unconditionally at top (React rules of hooks).

function AgentSettingsGuard() {
  const { role, loading } = useCurrentRole();
  const lang = useConsoleLang();

  if (loading) {
    return <LoadingState />;
  }

  // Fail-closed: only admin and supervisor allowed
  if (role !== "admin" && role !== "supervisor") {
    return <PermissionDenied message={COPY[lang].permissionDenied} />;
  }

  return <AgentSettingsContent currentRole={role} />;
}

// ── Content component ──

function AgentSettingsContent({ currentRole }: { currentRole: "admin" | "supervisor" }) {
  const lang = useConsoleLang();
  const copy = COPY[lang];
  const isAdmin = currentRole === "admin";

  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [userRoles, setUserRoles] = useState<UserRole[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState(false);
  const [roleError, setRoleError] = useState(false);

  const loadData = useCallback(async () => {
    setLoadingData(true);
    setError(false);
    setRoleError(false);
    setUserRoles([]);

    try {
      // 1. Load agent profiles (verified schema columns)
      const { data: profileData, error: profileErr } = await supabase
        .from("agent_profile")
        .select("id, user_id, display_name, email, role, status")
        .order("display_name", { ascending: true });

      if (profileErr) {
        setError(true);
        setLoadingData(false);
        return;
      }

      setAgents(profileData || []);

      // 2. Admin: also load production roles from user_roles
      if (isAdmin) {
        // Deduplicate user_ids
        const linkedUserIds = [
          ...new Set((profileData || []).map((a) => a.user_id).filter((uid): uid is string => uid !== null)),
        ];

        if (linkedUserIds.length > 0) {
          const { data: rolesData, error: rolesErr } = await supabase
            .from("user_roles")
            .select("user_id, role")
            .in("user_id", linkedUserIds);

          if (rolesErr) {
            setRoleError(true);
          } else {
            setUserRoles(rolesData || []);
          }
        }
      }
    } catch {
      setError(true);
    } finally {
      setLoadingData(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Loading state ──
  if (loadingData) {
    return <LoadingState />;
  }

  // ── Error state ──
  if (error) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "80px 20px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 40, marginBottom: 14 }}>⚠️</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{copy.loadError}</div>
        <button
          onClick={loadData}
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: "6px 16px",
            borderRadius: 8,
            border: "0.5px solid #e8e6e0",
            background: "#fff",
            cursor: "pointer",
            marginTop: 8,
          }}
        >
          {copy.retry}
        </button>
      </div>
    );
  }

  // ── Empty state ──
  if (agents.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "80px 20px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 40, marginBottom: 14 }}>📋</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{copy.emptyTitle}</div>
        <div style={{ fontSize: 12, color: "#888", maxWidth: 320 }}>{copy.emptyHint}</div>
      </div>
    );
  }

  // ── Build role lookup (admin only) ──
  const roleMap = new Map<string, string[]>();
  if (isAdmin) {
    for (const ur of userRoles) {
      const existing = roleMap.get(ur.user_id) || [];
      existing.push(ur.role);
      roleMap.set(ur.user_id, existing);
    }
  }

  return (
    <div style={{ maxWidth: 900, padding: 4 }}>
      {/* Supervisor info banner */}
      {!isAdmin && (
        <div
          style={{
            background: "#fffbeb",
            border: "0.5px solid #fbbf24",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 11,
            color: "#92400e",
            marginBottom: 12,
          }}
        >
          ℹ️ {copy.supervisorBanner}
        </div>
      )}

      {/* Role query error warning (admin only) */}
      {isAdmin && roleError && (
        <div
          style={{
            background: "#fef2f2",
            border: "0.5px solid #fca5a5",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 11,
            color: "#991b1b",
            marginBottom: 12,
          }}
        >
          ⚠️ {copy.roleQueryFailed}
        </div>
      )}

      {/* Agent cards */}
      <div style={{ display: "grid", gap: 12 }}>
        {agents.map((a) => {
          const userId = a.user_id;
          const isLinked = userId !== null;
          const prodRoles = isAdmin && isLinked ? roleMap.get(userId) : undefined;
          const prodRoleList = prodRoles || [];
          const hasProdRole = prodRoleList.length > 0;
          const legacyRole = a.role;

          const legacyDiffersFromProd =
            isAdmin && !roleError && isLinked && hasProdRole && !prodRoleList.includes(legacyRole);

          return (
            <div
              key={a.id}
              style={{
                background: "#fff",
                border: "0.5px solid #e8e6e0",
                borderRadius: 11,
                padding: 14,
              }}
            >
              {/* Top row: avatar + name + details */}
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  marginBottom: 8,
                }}
              >
                {/* Avatar initials */}
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: "#f0efe9",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    fontSize: 13,
                    flexShrink: 0,
                  }}
                >
                  {initials(a.display_name)}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Name */}
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{a.display_name}</div>

                  {/* Email */}
                  <div style={{ fontSize: 11, color: "#666", marginBottom: 4 }}>{a.email}</div>

                  {/* Link status */}
                  <div style={{ fontSize: 10.5, marginBottom: 4 }}>
                    {isLinked ? (
                      <span style={{ color: "#2d7d4f", fontWeight: 600 }}>🔗 {copy.linked}</span>
                    ) : (
                      <span style={{ color: "#dc2626", fontWeight: 600 }}>⚠️ {copy.unlinked}</span>
                    )}
                  </div>

                  {/* Account status */}
                  <div style={{ fontSize: 11, color: "#666" }}>
                    {copy.accountStatus} {formatStatus(a.status, copy.statusUnknown)}
                  </div>
                </div>
              </div>

              {/* Admin-only: production role badges + legacy warnings */}
              {/* Hidden entirely when roleError — avoids false "No production role" */}
              {isAdmin && !roleError && (
                <div style={{ marginTop: 6 }}>
                  {!isLinked ? (
                    /* Unlinked: show legacy label only */
                    legacyRole ? (
                      <div style={{ fontSize: 10, color: "#666" }}>
                        {copy.profileLabel} <span style={{ fontWeight: 600 }}>{legacyRole}</span>{" "}
                        <span style={{ color: "#888" }}>({copy.nonAuthoritative})</span>
                      </div>
                    ) : null
                  ) : !hasProdRole ? (
                    /* Case B: linked but no production role */
                    <div>
                      <span
                        style={{
                          fontSize: 10,
                          color: "#92400e",
                          background: "#fef3c7",
                          padding: "2px 8px",
                          borderRadius: 20,
                          fontWeight: 600,
                        }}
                      >
                        {copy.noProductionRole}
                      </span>
                      {/* Show legacy label as non-authoritative */}
                      {legacyRole && (
                        <div
                          style={{
                            fontSize: 10,
                            color: "#666",
                            marginTop: 4,
                          }}
                        >
                          {copy.profileLabel} <span style={{ fontWeight: 600 }}>{legacyRole}</span>{" "}
                          <span style={{ color: "#888" }}>({copy.nonAuthoritative})</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    /* Case A: has production role(s) */
                    <div
                      style={{
                        display: "flex",
                        gap: 4,
                        flexWrap: "wrap",
                        alignItems: "center",
                      }}
                    >
                      {prodRoleList.map((r) => (
                        <span
                          key={r}
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: "#1d4ed8",
                            background: "#dbeafe",
                            padding: "2px 8px",
                            borderRadius: 20,
                          }}
                        >
                          {r}
                        </span>
                      ))}
                      {prodRoleList.length > 1 && (
                        <span
                          style={{
                            fontSize: 10,
                            color: "#92400e",
                            fontWeight: 600,
                          }}
                        >
                          ({copy.multipleRoles})
                        </span>
                      )}
                    </div>
                  )}

                  {/* Legacy role differs from production role warning */}
                  {legacyDiffersFromProd && (
                    <div
                      style={{
                        fontSize: 10,
                        color: "#92400e",
                        background: "#fffbeb",
                        border: "0.5px solid #fbbf24",
                        borderRadius: 6,
                        padding: "4px 8px",
                        marginTop: 6,
                      }}
                    >
                      ⚠️ {copy.legacyDiffers}
                      <br />
                      {copy.profileLabel} <span style={{ fontWeight: 600 }}>{legacyRole}</span>{" "}
                      <span style={{ color: "#888" }}>({copy.nonAuthoritative})</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div
        style={{
          fontSize: 10,
          color: "#aaa",
          marginTop: 12,
          textAlign: "right",
        }}
      >
        {copy.agentCount(agents.length)}
      </div>
    </div>
  );
}
