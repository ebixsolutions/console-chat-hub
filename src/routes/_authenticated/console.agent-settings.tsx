import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/console/agent-settings")({
  component: AgentSettingsGuard,
});

// ── Bilingual copy ──

type Lang = "en" | "zh";

const COPY = {
  en: {
    permissionDenied: "You do not have permission to view agent settings.",
    title: "Agent Settings",
    addAgent: "Add Agent",
    refresh: "Refresh",
    loadError: "Unable to load agents.",
    retry: "Retry",
    emptyTitle: "No agents found",
    agentCount: (n: number) => `${n} agent${n === 1 ? "" : "s"}`,
    statusActive: "Active",
    statusInactive: "Inactive",
    statusUnknown: "Unknown",
    disable: "Disable",
    reactivate: "Reactivate",
    changeRole: "Change role",
    confirm: "Confirm",
    cancel: "Cancel",
    close: "Close",
    // Add Agent dialog
    addTitle: "Add Agent",
    addDesc: "Look up an existing authenticated user by email, then assign a role.",
    emailLabel: "Email",
    lookup: "Look up",
    userFound: "User found",
    userNotFound: "No user with that email",
    profileExists: "This user already has an agent profile.",
    displayNameLabel: "Display name",
    roleLabel: "Role",
    roleAdmin: "Admin",
    roleSupervisor: "Supervisor",
    roleAgent: "Agent",
    supervisorRoleOnly: "Role: Agent",
    // Disable dialog
    disableTitle: "Disable agent?",
    disableDesc:
      "This will deactivate the agent and unassign their conversations. They will no longer be able to sign in as an agent.",
    // Reactivate dialog
    reactivateTitle: "Reactivate agent",
    reactivateDesc: "Choose the role to restore.",
    // Change role dialog
    changeTitle: "Change role",
    changeDesc: "Select a new role for this agent.",
    // Toasts
    tSessionExpired: "Session expired, please log in again.",
    tGeneric: "Something went wrong.",
    tAdded: "Agent added.",
    tRoleChanged: "Role updated.",
    tDeactivated: "Agent deactivated.",
    tReactivated: "Agent reactivated.",
    unassigned: (n: number) => `${n} conversation${n === 1 ? "" : "s"} unassigned.`,
    cannotSelf: "You cannot perform this action on your own account.",
  },
  zh: {
    permissionDenied: "您沒有權限查看客服設定。",
    title: "客服設定",
    addAgent: "新增客服",
    refresh: "重新載入",
    loadError: "無法載入客服人員資料。",
    retry: "重試",
    emptyTitle: "尚無客服人員",
    agentCount: (n: number) => `${n} 位客服人員`,
    statusActive: "啟用中",
    statusInactive: "已停用",
    statusUnknown: "未知",
    disable: "停用",
    reactivate: "重新啟用",
    changeRole: "變更角色",
    confirm: "確認",
    cancel: "取消",
    close: "關閉",
    addTitle: "新增客服",
    addDesc: "以電子郵件查找已註冊使用者，然後指派角色。",
    emailLabel: "電子郵件",
    lookup: "查找",
    userFound: "已找到使用者",
    userNotFound: "找不到此電子郵件的使用者",
    profileExists: "此使用者已有客服檔案。",
    displayNameLabel: "顯示名稱",
    roleLabel: "角色",
    roleAdmin: "管理員",
    roleSupervisor: "主管",
    roleAgent: "客服",
    supervisorRoleOnly: "角色：客服",
    disableTitle: "確定要停用此客服？",
    disableDesc: "此操作將停用該客服，並取消其負責的對話。停用後無法以客服身份登入。",
    reactivateTitle: "重新啟用客服",
    reactivateDesc: "請選擇欲恢復的角色。",
    changeTitle: "變更角色",
    changeDesc: "請選擇此客服的新角色。",
    tSessionExpired: "登入已過期，請重新登入。",
    tGeneric: "發生錯誤。",
    tAdded: "已新增客服。",
    tRoleChanged: "已變更角色。",
    tDeactivated: "已停用客服。",
    tReactivated: "已重新啟用客服。",
    unassigned: (n: number) => `已釋出 ${n} 個對話。`,
    cannotSelf: "無法對自己執行此操作。",
  },
} satisfies Record<Lang, Record<string, unknown>>;

// ── Types ──

interface AgentRow {
  id: string;
  user_id: string | null;
  display_name: string;
  email: string;
  role: string;
  status: string | null;
  created_at?: string;
  updated_at?: string;
}

interface FindUserResult {
  found?: boolean;
  user_id?: string;
  email?: string;
  has_profile?: boolean;
  profile_status?: string | null;
  [k: string]: unknown;
}

interface EfResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  error_type?: string;
}

// ── Helpers ──

async function callAgentMgmt<T = unknown>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<EfResponse<T>> {
  const { data, error } = await supabase.functions.invoke("agent-management", {
    body: { action, ...payload },
  });
  if (error) {
    // FunctionsHttpError carries context; return as failure shape
    const body = (data as EfResponse<T> | null) ?? {
      success: false,
      error: error.message || "Request failed",
      error_type: "server_error",
    };
    return body;
  }
  return data as EfResponse<T>;
}

function handleEfError(res: EfResponse, lang: Lang) {
  const c = COPY[lang];
  if (!res.error) {
    toast.error(c.tGeneric);
    return;
  }
  if (res.error_type === "unauthorized") {
    toast.error(c.tSessionExpired);
    return;
  }
  toast.error(res.error);
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function roleBadgeStyle(role: string): React.CSSProperties {
  const map: Record<string, { bg: string; fg: string }> = {
    admin: { bg: "#fee2e2", fg: "#991b1b" },
    super_admin: { bg: "#fee2e2", fg: "#991b1b" },
    supervisor: { bg: "#dbeafe", fg: "#1d4ed8" },
    agent: { bg: "#dcfce7", fg: "#166534" },
  };
  const c = map[role] || { bg: "#f3f4f6", fg: "#374151" };
  return {
    background: c.bg,
    color: c.fg,
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 20,
  };
}

function statusBadge(status: string | null, lang: Lang): { label: string; style: React.CSSProperties } {
  const c = COPY[lang];
  if (status === "active") {
    return {
      label: c.statusActive,
      style: {
        background: "#dcfce7",
        color: "#166534",
        fontSize: 10,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 20,
      },
    };
  }
  if (status === "inactive") {
    return {
      label: c.statusInactive,
      style: {
        background: "#e5e7eb",
        color: "#374151",
        fontSize: 10,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 20,
      },
    };
  }
  return {
    label: c.statusUnknown,
    style: {
      background: "#f3f4f6",
      color: "#6b7280",
      fontSize: 10,
      fontWeight: 600,
      padding: "2px 8px",
      borderRadius: 20,
    },
  };
}

// ── Guard ──

function AgentSettingsGuard() {
  const { role, loading } = useCurrentRole();
  const lang = useConsoleLang();

  if (loading) return <LoadingState />;
  if (role !== "admin" && role !== "supervisor") {
    return <PermissionDenied message={COPY[lang].permissionDenied} />;
  }
  return <AgentSettingsContent currentRole={role} />;
}

// ── Content ──

function AgentSettingsContent({ currentRole }: { currentRole: "admin" | "supervisor" }) {
  const lang = useConsoleLang();
  const c = COPY[lang];
  const isAdmin = currentRole === "admin";

  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [disableTarget, setDisableTarget] = useState<AgentRow | null>(null);
  const [reactivateTarget, setReactivateTarget] = useState<AgentRow | null>(null);
  const [changeTarget, setChangeTarget] = useState<AgentRow | null>(null);

  const loadData = useCallback(async () => {
    setLoadingData(true);
    setError(false);
    const res = await callAgentMgmt<{ agents: AgentRow[] }>("list_agents");
    if (!res.success) {
      setError(true);
      setLoadingData(false);
      handleEfError(res, lang);
      return;
    }
    setAgents(res.data?.agents ?? []);
    setLoadingData(false);
  }, [lang]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? null));
  }, []);

  if (loadingData) return <LoadingState />;

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{c.loadError}</div>
        <Button size="sm" onClick={loadData}>
          {c.retry}
        </Button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 960, padding: 4 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>{c.title}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="outline" size="sm" onClick={loadData}>
            {c.refresh}
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            {c.addAgent}
          </Button>
        </div>
      </div>

      {/* Empty */}
      {agents.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center", color: "#666", fontSize: 13 }}>{c.emptyTitle}</div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {agents.map((a) => {
            const isSelf = currentUserId !== null && a.user_id === currentUserId;
            const canManage =
              !isSelf &&
              (isAdmin
                ? a.role !== "super_admin"
                : a.role === "agent");
            const canChangeRole = isAdmin && !isSelf && a.role !== "super_admin" && a.user_id !== null;
            const st = statusBadge(a.status, lang);

            return (
              <div
                key={a.id}
                style={{
                  background: "#fff",
                  border: "0.5px solid #e8e6e0",
                  borderRadius: 11,
                  padding: 14,
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                }}
              >
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
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{a.display_name}</div>
                  <div style={{ fontSize: 11, color: "#666", marginBottom: 6 }}>{a.email}</div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={roleBadgeStyle(a.role)}>{a.role}</span>
                    <span style={st.style}>{st.label}</span>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {canChangeRole && a.status === "active" && (
                    <Button variant="outline" size="sm" onClick={() => setChangeTarget(a)}>
                      {c.changeRole}
                    </Button>
                  )}
                  {canManage && a.status === "active" && (
                    <Button variant="outline" size="sm" onClick={() => setDisableTarget(a)}>
                      {c.disable}
                    </Button>
                  )}
                  {canManage && a.status === "inactive" && (
                    <Button variant="outline" size="sm" onClick={() => setReactivateTarget(a)}>
                      {c.reactivate}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 10, color: "#aaa", marginTop: 12, textAlign: "right" }}>
        {c.agentCount(agents.length)}
      </div>

      {/* Dialogs */}
      <AddAgentDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        isAdmin={isAdmin}
        lang={lang}
        onDone={loadData}
      />
      <DisableDialog
        target={disableTarget}
        onOpenChange={(v) => !v && setDisableTarget(null)}
        lang={lang}
        onDone={loadData}
      />
      <ReactivateDialog
        target={reactivateTarget}
        onOpenChange={(v) => !v && setReactivateTarget(null)}
        isAdmin={isAdmin}
        lang={lang}
        onDone={loadData}
      />
      <ChangeRoleDialog
        target={changeTarget}
        onOpenChange={(v) => !v && setChangeTarget(null)}
        lang={lang}
        onDone={loadData}
      />
    </div>
  );
}

// ── Add Agent Dialog ──

function AddAgentDialog({
  open,
  onOpenChange,
  isAdmin,
  lang,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  isAdmin: boolean;
  lang: Lang;
  onDone: () => void;
}) {
  const c = COPY[lang];
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [appRole, setAppRole] = useState<string>("agent");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [addLoading, setAddLoading] = useState(false);
  const [found, setFound] = useState<FindUserResult | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setEmail("");
      setDisplayName("");
      setAppRole("agent");
      setFound(null);
      setDialogError(null);
      setLookupLoading(false);
      setAddLoading(false);
    }
  }, [open]);

  const doLookup = async () => {
    setDialogError(null);
    setFound(null);
    if (!email.trim() || !email.includes("@")) {
      setDialogError(c.emailLabel);
      return;
    }
    setLookupLoading(true);
    const res = await callAgentMgmt<FindUserResult>("find_user", { email: email.trim() });
    setLookupLoading(false);
    if (!res.success) {
      setDialogError(res.error || c.tGeneric);
      return;
    }
    setFound(res.data ?? { found: false });
  };

  const doAdd = async () => {
    if (!found?.user_id) return;
    setAddLoading(true);
    setDialogError(null);
    const res = await callAgentMgmt("add_agent", {
      target_user_id: found.user_id,
      app_role: isAdmin ? appRole : "agent",
      display_name: displayName.trim() || null,
    });
    setAddLoading(false);
    if (!res.success) {
      setDialogError(res.error || c.tGeneric);
      return;
    }
    toast.success(c.tAdded);
    onOpenChange(false);
    onDone();
  };

  const canShowStep2 = found?.found && found.user_id && !found.has_profile;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{c.addTitle}</DialogTitle>
          <DialogDescription>{c.addDesc}</DialogDescription>
        </DialogHeader>

        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>{c.emailLabel}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                disabled={lookupLoading || addLoading}
              />
              <Button onClick={doLookup} disabled={lookupLoading || addLoading} size="sm">
                {lookupLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : c.lookup}
              </Button>
            </div>
          </div>

          {found && !found.found && (
            <div style={{ fontSize: 12, color: "#991b1b" }}>{c.userNotFound}</div>
          )}
          {found?.found && found.has_profile && (
            <div style={{ fontSize: 12, color: "#92400e" }}>{c.profileExists}</div>
          )}

          {canShowStep2 && (
            <>
              <div style={{ fontSize: 12, color: "#166534" }}>✓ {c.userFound}</div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>{c.displayNameLabel}</div>
                <Input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={addLoading}
                />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>{c.roleLabel}</div>
                {isAdmin ? (
                  <Select value={appRole} onValueChange={setAppRole} disabled={addLoading}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">{c.roleAdmin}</SelectItem>
                      <SelectItem value="supervisor">{c.roleSupervisor}</SelectItem>
                      <SelectItem value="agent">{c.roleAgent}</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <div style={{ fontSize: 12, color: "#374151" }}>{c.supervisorRoleOnly}</div>
                )}
              </div>
            </>
          )}

          {dialogError && (
            <div style={{ fontSize: 12, color: "#991b1b" }}>{dialogError}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={addLoading}>
            {c.cancel}
          </Button>
          {canShowStep2 && (
            <Button onClick={doAdd} disabled={addLoading}>
              {addLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : c.addAgent}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Disable Dialog ──

function DisableDialog({
  target,
  onOpenChange,
  lang,
  onDone,
}: {
  target: AgentRow | null;
  onOpenChange: (v: boolean) => void;
  lang: Lang;
  onDone: () => void;
}) {
  const c = COPY[lang];
  const [loading, setLoading] = useState(false);

  const confirm = async () => {
    if (!target) return;
    setLoading(true);
    const res = await callAgentMgmt<{ unassigned_count?: number }>("deactivate", { agent_id: target.id });
    setLoading(false);
    if (!res.success) {
      handleEfError(res, lang);
      return;
    }
    const n = res.data?.unassigned_count;
    toast.success(typeof n === "number" && n > 0 ? `${c.tDeactivated} ${c.unassigned(n)}` : c.tDeactivated);
    onOpenChange(false);
    onDone();
  };

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{c.disableTitle}</DialogTitle>
          <DialogDescription>{c.disableDesc}</DialogDescription>
        </DialogHeader>
        {target && (
          <div style={{ fontSize: 12, color: "#374151" }}>
            {target.display_name} · {target.email}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {c.cancel}
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : c.disable}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Reactivate Dialog ──

function ReactivateDialog({
  target,
  onOpenChange,
  isAdmin,
  lang,
  onDone,
}: {
  target: AgentRow | null;
  onOpenChange: (v: boolean) => void;
  isAdmin: boolean;
  lang: Lang;
  onDone: () => void;
}) {
  const c = COPY[lang];
  const [role, setRole] = useState<string>("agent");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (target) setRole(isAdmin ? target.role || "agent" : "agent");
  }, [target, isAdmin]);

  const confirm = async () => {
    if (!target) return;
    setLoading(true);
    const res = await callAgentMgmt("reactivate", {
      agent_id: target.id,
      app_role: isAdmin ? role : "agent",
    });
    setLoading(false);
    if (!res.success) {
      handleEfError(res, lang);
      return;
    }
    toast.success(c.tReactivated);
    onOpenChange(false);
    onDone();
  };

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{c.reactivateTitle}</DialogTitle>
          <DialogDescription>{c.reactivateDesc}</DialogDescription>
        </DialogHeader>
        {target && (
          <div style={{ fontSize: 12, color: "#374151", marginBottom: 4 }}>
            {target.display_name} · {target.email}
          </div>
        )}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>{c.roleLabel}</div>
          {isAdmin ? (
            <Select value={role} onValueChange={setRole} disabled={loading}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">{c.roleAdmin}</SelectItem>
                <SelectItem value="supervisor">{c.roleSupervisor}</SelectItem>
                <SelectItem value="agent">{c.roleAgent}</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <div style={{ fontSize: 12 }}>{c.supervisorRoleOnly}</div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {c.cancel}
          </Button>
          <Button onClick={confirm} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : c.reactivate}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Change Role Dialog ──

function ChangeRoleDialog({
  target,
  onOpenChange,
  lang,
  onDone,
}: {
  target: AgentRow | null;
  onOpenChange: (v: boolean) => void;
  lang: Lang;
  onDone: () => void;
}) {
  const c = COPY[lang];
  const [role, setRole] = useState<string>("agent");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (target) setRole(target.role || "agent");
  }, [target]);

  const confirm = async () => {
    if (!target || !target.user_id) return;
    setLoading(true);
    const res = await callAgentMgmt("change_role", {
      target_user_id: target.user_id,
      new_role: role,
    });
    setLoading(false);
    if (!res.success) {
      handleEfError(res, lang);
      return;
    }
    toast.success(c.tRoleChanged);
    onOpenChange(false);
    onDone();
  };

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{c.changeTitle}</DialogTitle>
          <DialogDescription>{c.changeDesc}</DialogDescription>
        </DialogHeader>
        {target && (
          <div style={{ fontSize: 12, color: "#374151", marginBottom: 4 }}>
            {target.display_name} · {target.email}
          </div>
        )}
        <Select value={role} onValueChange={setRole} disabled={loading}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">{c.roleAdmin}</SelectItem>
            <SelectItem value="supervisor">{c.roleSupervisor}</SelectItem>
            <SelectItem value="agent">{c.roleAgent}</SelectItem>
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {c.cancel}
          </Button>
          <Button onClick={confirm} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : c.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
