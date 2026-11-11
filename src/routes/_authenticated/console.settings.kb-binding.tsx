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
  const { role, actorId, loading: roleLoading } = useCurrentRole();
  const isOriginalDevOwner = actorId === "3bdf936e-b543-41d8-9fff-fa020a85f3f6";
  const [rows, setRows] = useState<KBDevBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState("");
  const [tenant, setTenant] = useState("");
  const [key, setKey] = useState("");
  const [active, setActive] = useState(false);
  const [savedRev, setSavedRev] = useState(0);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "supervisor" | "agent" | "qa">("agent");
  const [testPassword, setTestPassword] = useState("");
  const [newCompanyName, setNewCompanyName] = useState("");
  const [newTenant, setNewTenant] = useState("");
  const [newKey, setNewKey] = useState("");
  const [createdScope, setCreatedScope] = useState<{
    company_id: string; channel_id: string; user_id: string; kb_tenant_id: string;
  } | null>(null);
  const [action, setAction] = useState<"saving" | "inviting" | "reloading" | "linking" | "bootstrapping" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [phase, setPhase] = useState<"ready" | "unavailable" | "checking" | "read_only">("checking");

  const authorizedUI = role === "admin" && devPageHost();
  const current = useMemo(() => rows.find((r) => r.company_id === selected) ?? null, [rows, selected]);
  // Email is only a lookup key among server-returned, same-Admin Company members.
  // Access authority remains auth.uid(), active membership, role, and Company.
  const normalizedEmail = email.trim().toLowerCase();
  const matchingCompanies = useMemo(() => normalizedEmail
    ? rows.filter((row) => row.members.some((member) =>
        member.is_active && member.email?.trim().toLowerCase() === normalizedEmail))
    : [], [rows, normalizedEmail]);
  const verifiedLogin = Boolean(normalizedEmail && current?.members.some((member) =>
    member.is_active && member.email?.trim().toLowerCase() === normalizedEmail));
  const verifiedMember = verifiedLogin
    ? current?.members.find((member) => member.is_active &&
        member.email?.trim().toLowerCase() === normalizedEmail)
    : null;
  useEffect(() => {
    if (matchingCompanies.length === 1 && selected !== matchingCompanies[0].company_id) {
      setSelected(matchingCompanies[0].company_id);
    }
  }, [matchingCompanies, selected]);

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
      // A server-function/transport exception is NOT proof that Company data
      // are absent. Recover only genuinely authorized same-actor RLS scopes.
      // This does not authorize reading/writing a KB mapping.
      try {
        const scopes = await kbDevBindingService.listAuthorizedCompanyScopesReadOnly();
        if (scopes.ok) {
          setRows(scopes.data);
          setPhase("read_only");
          setSelected((old) => scopes.data.some((row) => row.company_id === old)
            ? old : scopes.data.length === 1 ? scopes.data[0].company_id : "");
          setError("Verified Company choices loaded read-only from the existing authenticated Supabase RLS. KB binding backend is unavailable; account creation, key entry and Save remain disabled.");
        } else {
          setRows([]);
          setPhase("unavailable");
          setError("Unable to retrieve authorized Company scope. RLS recovery: " + scopes.error);
        }
      } catch {
        setRows([]);
        setPhase("unavailable");
        setError("Unable to retrieve authorized Company scope (authenticated read-only recovery failed).");
      }
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
      setActive(false);
      setSavedRev(0);
    } else {
      setTenant(current.kb_tenant_id ?? "");
      setActive(current.is_active);
      setSavedRev(current.revision);
    }
    setKey("");
    setError(null);
    setSuccess(null);
  }, [current?.company_id, current?.revision, current?.kb_tenant_id, current?.kb_company_id, current?.is_active]);

  const save = async () => {
    if (!current || action || !verifiedLogin || !current.writer_ready) {
      setError("Select a verified login and Company with an available protected server writer.");
      return;
    }
    setError(null);
    setSuccess(null);
    setAction("saving");
    try {
      const result = await kbDevBindingService.save({
        company_id: current.company_id, kb_tenant_id: tenant.trim(),
        // Preserve optional legacy metadata; current Singapore RAG API consumes
        // the numeric KB company_id from kb_tenant_id, not this optional value.
        kb_company_id: current.kb_company_id ?? null, is_active: active,
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
      }
      await load(true);
    } catch {
      setError("Invitation could not be verified.");
    } finally {
      setAction(null);
    }
  };


  const createOrLink = async () => {
    if (!current || phase !== "ready" || action || !email.trim()) return;
    setAction("linking"); setError(null); setSuccess(null);
    try {
      const result = await kbDevBindingService.createOrLinkTestAccount({
        company_id: current.company_id, email: email.trim().toLowerCase(),
        role: inviteRole, ...(testPassword ? { password: testPassword } : {}),
      });
      if (!result.ok) { setError(result.error); return; }
      if (result.data.company_id !== current.company_id ||
          result.data.is_active !== true) {
        setError("Company role/membership readback was not verified.");
        return;
      }
      setSuccess("Real Auth user and SAME Company membership are active. " +
        "This account shares the existing Company's KB; no new Company was created.");
      await load(true);
    } catch {
      setError("Account creation/linking did not return a verified server result.");
    } finally {
      setTestPassword(""); setAction(null);
    }
  };
  const bootstrapTenant = async () => {
    if (action || !email.trim() || !/^[1-9]\d{0,15}$/.test(newTenant) ||
        newKey.length < 16 || newCompanyName.trim().length < 3) return;
    setAction("bootstrapping"); setError(null); setSuccess(null); setCreatedScope(null);
    try {
      const request_id = crypto.randomUUID();
      const result = await kbDevBindingService.bootstrapDevTenant({
        email: email.trim().toLowerCase(), company_name: newCompanyName.trim(),
        kb_tenant_id: newTenant, api_key: newKey, request_id,
        ...(testPassword ? { password: testPassword } : {}),
      });
      if (!result.ok) { setError(result.error); return; }
      if (!result.data.is_active || !result.data.has_key ||
          result.data.kb_tenant_id !== newTenant) {
        setError("The new tenant's DB/credential transaction has no valid readback.");
        return;
      }
      setCreatedScope(result.data);
      setSuccess("Dedicated Company, first Admin account, active Widget/Channel " +
        "and encrypted KB credential were atomically saved by the protected server. " +
        "Sign out and use the new account to verify automatic tenant selection.");
    } catch {
      setError("No verified tenant provisioning result was returned. " +
        "Check existing Auth/Company before retrying; never create duplicates.");
    } finally {
      setTestPassword(""); setNewKey(""); setAction(null);
    }
  };

  if (roleLoading) return <LoadingState />;
  if (!authorizedUI) return <PermissionDenied message="KB Tenant Binding is limited to a legitimate Admin in the authorized development/UAT Console." />;

  return (
    <div style={{ maxWidth: 1000, display: "grid", gap: 18, color: "#0f172a" }}>
      <header>
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>KB Tenant Binding — Development Only</h1>
        <p style={{ color: "#475569", marginTop: 4 }}>
          One-page setup: find or invite an AI Chatbot login into an Admin-authorized Company, then enter that Company's Singapore KB company_id and masked API Key below. A different KB tenant requires a separately authorized AI Chatbot Company, not just another email.
          This page is unavailable on the published Production Console.
        </p>
      </header>
      {phase === "unavailable" && <div role="alert" style={{ color: "#b91c1c" }}>Backend binding table/config is unavailable. No local or mock mapping will be used.</div>}
      {phase === "read_only" && <div role="status" style={{ color: "#9a3412" }}>
        Company choices below are verified by the existing authenticated Supabase RLS only.
        Binding metadata and other members have NOT been read. This is NOT a working KB binding or a grant.
      </div>}
      {error && <div role="alert" style={{ color: "#b91c1c" }}>{error}</div>}
      {success && <div role="status" style={{ color: "#166534" }}>{success}</div>}
      <section style={boxStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>1. AI Chatbot login account and authorized Company</h2>
          <button type="button" disabled={Boolean(action)} onClick={() => { void load(); }}>
            Reload live identity
          </button>
        </div>
        <label htmlFor="kb-login-email" style={{ display: "block", marginTop: 16, marginBottom: 6 }}>
          1. AI Chatbot login email
        </label>
        <input id="kb-login-email" type="email" autoComplete="off"
          style={fieldStyle} value={email} placeholder="admin@your-company.com"
          onChange={(e) => setEmail(e.target.value)} />
        {normalizedEmail && matchingCompanies.length === 0 &&
          <p role="status" style={{ fontSize: 12, color: "#b45309" }}>
            This login is not yet an active member of your authorized Companies. Select an authorized Company, use the server-authorized account invitation below, and verify the new membership before saving the KB binding.
          </p>}
        {matchingCompanies.length > 1 && <p role="status" style={{ fontSize: 12 }}>
          Multiple authorized Company memberships match this login. Select the intended Company below.
        </p>}
        <label htmlFor="kb-company-picker" style={{ display: "block", marginTop: 16, marginBottom: 6 }}>
          Verified AI Chatbot Company UUID (from active same-Company membership)
        </label>
        <select id="kb-company-picker" style={fieldStyle} value={selected} disabled={loading || Boolean(action)}
          onChange={(e) => setSelected(e.target.value)}>
          <option value="">Select your authorized Company</option>
          {rows.map((r) => <option value={r.company_id} key={r.company_id}>{r.company_name} — {r.company_id}</option>)}
        </select>
        {loading && <div role="status">Loading real Company / Auth identity…</div>}
        {verifiedMember && <p style={{ fontSize: 13, color: "#166534", marginTop: 9 }}>
          Verified login: {verifiedMember.email} · Auth UID: {verifiedMember.user_id}
          · Role: {verifiedMember.role}
        </p>}
        {current && <>
          <p style={{ fontSize: 13, color: "#475569", marginTop: 10 }}>
            Active Company Channel: {current.channels_ready ? "Verified" : "Not verified — saving disabled"}
            {phase === "read_only" && " · Binding operations unavailable"}
            {phase === "ready" && !current.writer_ready && " · Protected writer not available"}
          </p>
          <h3 style={{ fontWeight: 600, marginTop: 16 }}>Authenticated accounts on this Company</h3>
          <div style={{ display: "grid", gap: 5, marginTop: 8 }}>
            {phase === "read_only" && <p>Only your own verified login is shown while the binding backend is unavailable.</p>}
            {current.members.length ? current.members.map((member) =>
              <div key={member.user_id} style={{ fontSize: 13, padding: 6, background: "#f8fafc" }}>
                {member.email ?? "Email not available"} · {member.role} · {member.is_active ? "ACTIVE" : "PENDING / INACTIVE"} · {member.user_id}
              </div>) : <p>No active member records available.</p>}
          </div>
          <div style={{ marginTop: 16, display: "grid", gap: 8 }}>
            <p style={{ fontSize: 13, color: "#475569" }}>
              For a new login email entered above, invite a real test account only under the separately authorized
              same-Company Admin grant. Existing accounts are selected without an invitation.
            </p>
            <label htmlFor="invite-role">Authorized initial role (active after server grant and invite acceptance)</label>
            <select id="invite-role" value={inviteRole} style={fieldStyle}
              onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}>
              <option value="admin">Admin</option><option value="supervisor">Supervisor</option>
              <option value="agent">CS / Agent</option><option value="qa">QA</option>
            </select>
            <button type="button" disabled={phase !== "ready" || !current.writer_ready || Boolean(action) || !email.trim() || !current.channels_ready} onClick={() => void invite()}>
              {action === "inviting" ? "Sending authorized invite…" : "Invite new account and grant same-Company role"}
            </button>
            <p style={{ color: "#64748b", fontSize: 12 }}>
              An additional login in this same Company shares its KB tenant.
              Existing Supabase Auth login needs no email invitation; new mock login
              can use a test password without receiving email when authorized.
              A different KB tenant must use the separate Company section below.
            </p>
            <label htmlFor="kb-test-password">Test login password (only for a NEW mock Auth login; never reveal again)</label>
            <input id="kb-test-password" style={fieldStyle} type="password"
              value={testPassword} onChange={(e) => setTestPassword(e.target.value)}
              placeholder="Leave blank for an already-existing Auth user" autoComplete="new-password" />
            <button type="button"
              disabled={phase !== "ready" || !current.writer_ready || Boolean(action) || !email.trim() || !current.channels_ready}
              onClick={() => void createOrLink()}>
              {action === "linking" ? "Verifying account and Company…" :
                "Create / link test account in THIS Company (no invitation email)"}
            </button>
          </div>
        </>}
      </section>
      <section style={boxStyle}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>2. Singapore KB company_id and API Key</h2>
        <p style={{ fontSize: 12, color: "#64748b", marginTop: 8 }}>
          The Singapore KB API expects a numeric company_id (example: 34).
          This is stored as kb_tenant_id in the mapping, and is never the AI Chatbot Company UUID.
          A different KB account such as 35 needs verified remote entitlement and its own key.
          Each mapping belongs to one authorized AI Chatbot Company UUID, not to an email.
        </p>
        {!current && <p role="status" style={{ color: "#b45309", fontSize: 13 }}>
          Select a server-verified Company in step 1 to enable both fields. If Company loading is unavailable,
          these inputs stay visible but disabled; no local or mock mapping is substituted.
        </p>}
        {phase === "ready" && current && !current.writer_ready && <p role="alert"
          style={{ color: "#b45309", fontSize: 13 }}>
          Company/KB metadata is verified through your real Supabase Auth and same-Company RLS.
          The protected server writer is unavailable.
          {current.writer_status === "server_credential_unavailable"
            ? " The original private Preview server cannot access an authorized Supabase Admin key. Verify its Worker binding, or configure C3_KB_BINDING_ADMIN_KEY as a server-only secret for the original Supabase project (never VITE_)."
            : " The available server Admin key did not pass the original Supabase project's authorized Admin readback; verify its project binding."}
          {" "}You may prepare the numeric KB ID and masked key here, but Save stays disabled
          until a real authorized writer is verified; no binding is claimed or stored.
        </p>}
        {phase === "ready" && current && !current.writer_ready && <button
          type="button" disabled={Boolean(action)} onClick={() => void load()}>
          Recheck protected server writer
        </button>}
        <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
          <label htmlFor="kb-tenant-input">2. Singapore KB company_id (numeric, e.g. 34 or 35)</label>
          <input id="kb-tenant-input" style={fieldStyle} value={tenant} disabled={!current || phase !== "ready" || Boolean(action)}
            onChange={(e) => setTenant(e.target.value)} placeholder="34" inputMode="numeric" autoComplete="off" />
          <label htmlFor="kb-key-input">3. Singapore KB API Key — masked, write-only, never displayed again</label>
          <input id="kb-key-input" style={fieldStyle} type="password" value={key} disabled={!current || phase !== "ready" || Boolean(action)}
            onChange={(e) => setKey(e.target.value)} autoComplete="new-password" placeholder="Leave blank to retain stored secret" />
          <p style={{ fontSize: 12, color: "#64748b" }}>
            {phase === "read_only" ? "Stored Key, Revision and mapping state: Not loaded (backend unavailable)"
              : <>Stored Key: {current?.has_key ? "Configured (active, masked)" :
                    (current?.revision ?? 0) > 0 ? "Inactive; key presence is not exposed (re-enter a key to reactivate)" :
                    "Not configured"} ·
                Current Revision: {current?.revision ?? "—"} · Updated: {current?.updated_at ?? "Never"}</>}
          </p>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={active} disabled={!current || phase !== "ready"} onChange={(e) => setActive(e.target.checked)} />
            Activate (requires server-authorized Company/Channel and protected key)
          </label>
          <button type="button" disabled={!current || phase !== "ready" || !current?.writer_ready || Boolean(action) || !verifiedLogin || !current?.channels_ready || !/^[1-9]\d{0,15}$/.test(tenant) || (active && !current?.has_key && key.length < 16)}
            onClick={() => void save()}>
            {action === "saving" ? "Saving…" : "Save Company → KB binding (CAS)"}
          </button>
        </div>
      </section>
      {isOriginalDevOwner && <section style={boxStyle}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>3. New independent KB tenant — one-page setup</h2>
        <p style={{ fontSize: 13, color: "#475569" }}>
          Use this only if the login requires a DIFFERENT Singapore KB tenant.
          The first login becomes Admin of its own new Company, with its own active private
          Widget Channel. The original Frankie Company/KB34 is never modified.
          Do not use this for an account already assigned to a Company (including the current
          uat@ebixpro.com test login); instead sign in as that Company's own Admin and use section 2.
        </p>
        <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
          <label htmlFor="new-company-name">New test Company display name</label>
          <input id="new-company-name" style={fieldStyle} value={newCompanyName}
            onChange={(e) => setNewCompanyName(e.target.value)}
            placeholder="e.g. KB 51 UAT test Company" />
          <label htmlFor="new-kb-tenant">Singapore KB company_id / tenant ID (numeric)</label>
          <input id="new-kb-tenant" style={fieldStyle} value={newTenant}
            onChange={(e) => setNewTenant(e.target.value)}
            placeholder="e.g. 51" inputMode="numeric" />
          <label htmlFor="new-kb-key">New Singapore KB API Key — masked, write-only</label>
          <input id="new-kb-key" style={fieldStyle} type="password" value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="Enter here, not in ChatGPT or logs" autoComplete="new-password" />
          <p style={{ fontSize: 12, color: "#64748b" }}>
            Uses the login email from section 1; optional test password above only
            if this Auth email does not yet exist. This is one transactional
            Database Company/Role/Widget/KB+Vault setup; a newly created Supabase
            Auth user is a separate external step and is reported if incomplete.
            Only the original authorized development Owner may bootstrap tenants.
          </p>
          <button type="button"
            disabled={Boolean(action) || !email.trim() ||
              newCompanyName.trim().length < 3 || !/^[1-9]\d{0,15}$/.test(newTenant) ||
              newKey.length < 16}
            onClick={() => void bootstrapTenant()}>
            {action === "bootstrapping" ? "Provisioning protected tenant…" :
              "Create independent Company + Admin + Widget + KB binding"}
          </button>
          {createdScope && <div role="status" style={{ color: "#166534", fontSize: 13 }}>
            Verified: Auth UID {createdScope.user_id}, Company UUID {createdScope.company_id},
            Widget Channel UUID {createdScope.channel_id}, Singapore KB {createdScope.kb_tenant_id}.
            Key bytes were never returned. This record is NOT external KB entitlement
            or a successful paid RAG UAT result.
          </div>}
        </div>
      </section>}
      <p style={{ color: "#64748b", fontSize: 12 }}>
        Setup sequence on this page: select or invite a real account under an authorized Company,
        enter the numeric Singapore KB company_id and a masked write-only API Key,
        activate and save the Company binding, then test the invitee's legitimate login.
        The account invitation and binding save are separate governed actions, not an unverified atomic transaction.
        On the next legitimate login, one authorized Company should resolve automatically.
        If an actor has more than one active Company membership, only those server-verified
        Companies may be selected; switching must clear Company-scoped session, Ticket,
        Widget and KB contexts. A saved mapping is not proof of remote KB entitlement
        or successful RAG until the original live authenticated test passes.
      </p>
    </div>
  );
}