import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";
import { isKBDevHost, kbDevBindingService, type KBDevBinding } from "@/lib/api/kbBinding.service";

export const Route = createFileRoute("/_authenticated/console/settings/kb-binding")({
  component: KBDevBindingPage,
});

const boxStyle = { border: "1px solid #e2e8f0", borderRadius: 12, padding: 20, background: "#fff" };
const fieldStyle = { width: "100%", padding: 10, borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff" };
const envEnabled = import.meta.env.VITE_C3_KB_BINDING_DEV_ENABLED === "true";
const devPageHost = () => typeof window !== "undefined" && isKBDevHost(window.location.host, envEnabled);

function KBDevBindingPage() {
  const { role, loading: roleLoading } = useCurrentRole();
  const [rows, setRows] = useState<KBDevBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState("");
  const [tenant, setTenant] = useState("");
  const [kbCompany, setKbCompany] = useState("");
  const [key, setKey] = useState("");
  const [active, setActive] = useState(false);
  const [savedRev, setSavedRev] = useState(0);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "supervisor" | "agent" | "qa">("agent");
  const [action, setAction] = useState<"saving" | "inviting" | "reloading" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [phase, setPhase] = useState<"ready" | "unavailable" | "checking">("checking");

  const authorizedUI = role === "admin" && devPageHost();
  const current = useMemo(() => rows.find((r) => r.company_id === selected) ?? null, [rows, selected]);

  const load = async (preserveSuccess = false) => {
    setError(null);
    if (!preserveSuccess) setSuccess(null);
    setLoading(true);
    try {
      const result = await kbDevBindingService.list();
      if (!result.ok) {
        setPhase("unavailable");
        setError(result.error);
        return;
      }
      setRows(result.data);
      setPhase("ready");
      setSelected((old) => result.data.some((row) => row.company_id === old)
        ? old : result.data.length === 1 ? result.data[0].company_id : "");
    } catch {
      setPhase("unavailable");
      setError("Unable to retrieve authorized Company scope.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (roleLoading || !authorizedUI) return;
    void load();
  }, [roleLoading, authorizedUI]);

  useEffect(() => {
    if (!current) {
      setTenant("");
      setKbCompany("");
      setActive(false);
      setSavedRev(0);
    } else {
      setTenant(current.kb_tenant_id ?? "");
      setKbCompany(current.kb_company_id ?? "");
      setActive(current.is_active);
      setSavedRev(current.revision);
    }
    setKey("");
    setError(null);
    setSuccess(null);
  }, [current?.company_id, current?.revision, current?.kb_tenant_id, current?.kb_company_id, current?.is_active]);

  const save = async () => {
    if (!current || action) return;
    setError(null);
    setSuccess(null);
    setAction("saving");
    try {
      const result = await kbDevBindingService.save({
        company_id: current.company_id, kb_tenant_id: tenant.trim(),
        kb_company_id: kbCompany.trim() || null, is_active: active,
        expected_revision: savedRev, ...(key ? { api_key: key } : {}),
      });
      if (!result.ok) {
        setError(result.error === "binding_revision_conflict_reload"
          ? "This binding changed in another session. Reload before trying again."
          : result.error);
        return;
      }
      // Clear the write-only key immediately, regardless of successful rotation.
      setKey("");
      setSavedRev(result.data.revision);
      setSuccess("Saved to the authorized Company binding. Sign out/in to test the new automatic scope.");
      await load(true);
    } catch {
      setError("Binding update failed. No success is claimed.");
    } finally {
      setKey("");
      setAction(null);
    }
  };
  const invite = async () => {
    if (!current || action || !email.trim()) return;
    setAction("inviting");
    setError(null);
    setSuccess(null);
    try {
      const result = await kbDevBindingService.invite({
        company_id: current.company_id,
        email: email.trim().toLowerCase(),
        role: inviteRole,
      });
      if (!result.ok) {
        setError(result.error);
      } else {
        setSuccess("Invitation sent; the same-Company role and membership are active. The invitee must accept the Auth invitation before logging in.");
        setEmail("");
      }
      await load(true);
    } catch {
      setError("Invitation could not be verified.");
    } finally {
      setAction(null);
    }
  };

  if (roleLoading) return <LoadingState />;
  if (!authorizedUI) return <PermissionDenied message="KB Tenant Binding is limited to a legitimate Admin in the authorized development/UAT Console." />;

  return (
    <div style={{ maxWidth: 1000, display: "grid", gap: 18, color: "#0f172a" }}>
      <header>
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>KB Tenant Binding — Development Only</h1>
        <p style={{ color: "#475569", marginTop: 4 }}>
          Link a legitimate AI Chatbot Company UUID to its distinct Singapore Knowledge Base Tenant ID.
          This page is unavailable on the published Production Console.
        </p>
      </header>
      {phase === "unavailable" && <div role="alert" style={{ color: "#b91c1c" }}>Backend binding table/config is unavailable. No local or mock mapping will be used.</div>}
      {error && <div role="alert" style={{ color: "#b91c1c" }}>{error}</div>}
      {success && <div role="status" style={{ color: "#166534" }}>{success}</div>}
      <section style={boxStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>1. Authorized Company and login account</h2>
          <button type="button" disabled={Boolean(action)} onClick={() => { void load(); }}>
            Reload live identity
          </button>
        </div>
        <label htmlFor="kb-company-picker" style={{ display: "block", marginTop: 16, marginBottom: 6 }}>AI Chatbot Company (active Admin membership only)</label>
        <select id="kb-company-picker" style={fieldStyle} value={selected} disabled={loading || Boolean(action)}
          onChange={(e) => setSelected(e.target.value)}>
          <option value="">Select your authorized Company</option>
          {rows.map((r) => <option value={r.company_id} key={r.company_id}>{r.company_name} — {r.company_id}</option>)}
        </select>
        {loading && <div role="status">Loading real Company / Auth identity…</div>}
        {current && <>
          <p style={{ fontSize: 13, color: "#475569", marginTop: 10 }}>
            Active Company Channel: {current.channels_ready ? "Verified" : "Not verified — saving disabled"}
          </p>
          <h3 style={{ fontWeight: 600, marginTop: 16 }}>Authenticated accounts on this Company</h3>
          <div style={{ display: "grid", gap: 5, marginTop: 8 }}>
            {current.members.length ? current.members.map((member) =>
              <div key={member.user_id} style={{ fontSize: 13, padding: 6, background: "#f8fafc" }}>
                {member.email ?? "Email not available"} · {member.role} · {member.is_active ? "ACTIVE" : "PENDING / INACTIVE"} · {member.user_id}
              </div>) : <p>No active member records available.</p>}
          </div>
          <div style={{ marginTop: 16, display: "grid", gap: 8 }}>
            <label htmlFor="invite-email">Invite a new test account (separate authorized invite permission required)</label>
            <input id="invite-email" type="email" autoComplete="off" value={email} style={fieldStyle}
              onChange={(e) => setEmail(e.target.value)} placeholder="test@example.com" />
            <label htmlFor="invite-role">Authorized initial role (active after server grant and invite acceptance)</label>
            <select id="invite-role" value={inviteRole} style={fieldStyle}
              onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}>
              <option value="admin">Admin</option><option value="supervisor">Supervisor</option>
              <option value="agent">CS / Agent</option><option value="qa">QA</option>
            </select>
            <button type="button" disabled={Boolean(action) || !email.trim() || !current.channels_ready} onClick={() => void invite()}>
              {action === "inviting" ? "Sending authorized invite…" : "Invite account and grant same-Company role"}
            </button>
          </div>
        </>}
      </section>
      {current && <section style={boxStyle}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>2. Singapore KB binding and masked credential</h2>
        <p style={{ fontSize: 12, color: "#64748b", marginTop: 8 }}>
          AI Company UUID ≠ Singapore KB Tenant ID. Example: existing Frankie Tenant 34;
          Tenant 35 requires a real separately verified owner credential and published knowledge.
        </p>
        <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
          <label htmlFor="kb-tenant-input">Singapore KB Tenant ID (required string)</label>
          <input id="kb-tenant-input" style={fieldStyle} value={tenant}
            onChange={(e) => setTenant(e.target.value)} placeholder="34" autoComplete="off" />
          <label htmlFor="kb-company-input">Singapore KB-side Company ID (optional, only where API requires)</label>
          <input id="kb-company-input" style={fieldStyle} value={kbCompany}
            onChange={(e) => setKbCompany(e.target.value)} placeholder="Leave blank if not in API contract" />
          <label htmlFor="kb-key-input">Singapore KB API Key — masked, write-only, never displayed again</label>
          <input id="kb-key-input" style={fieldStyle} type="password" value={key}
            onChange={(e) => setKey(e.target.value)} autoComplete="new-password" placeholder="Leave blank to retain stored secret" />
          <p style={{ fontSize: 12, color: "#64748b" }}>
            Stored Key: {current.has_key ? "Configured (masked)" : "Not configured"} ·
            Current Revision: {current.revision} · Updated: {current.updated_at ?? "Never"}
          </p>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Activate (requires server-authorized Company/Channel and protected key)
          </label>
          <button type="button" disabled={Boolean(action) || !current.channels_ready || !/^[1-9]\d{0,15}$/.test(tenant) || (active && !current.has_key && key.length < 16)}
            onClick={() => void save()}>
            {action === "saving" ? "Saving…" : "Save Company → KB binding (CAS)"}
          </button>
        </div>
      </section>}
      <p style={{ color: "#64748b", fontSize: 12 }}>
        On the next legitimate login, one authorized Company should resolve automatically.
        If an actor has more than one active Company membership, only those server-verified
        Companies may be selected; switching must clear Company-scoped session, Ticket,
        Widget and KB contexts. A saved mapping is not proof of remote KB entitlement
        or successful RAG until the original live authenticated test passes.
      </p>
    </div>
  );
}