import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const BASE='1e728356a42e5c1390294753ea20dc20b5d56c39';
const branch='director/ai-abc-c3-long-memory-final-cutover';
const sha=s=>createHash('sha256').update(s).digest('hex');
const run=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8'}).trim();
assert.equal(process.env.GITHUB_REF,`refs/heads/${branch}`);
assert.equal(run('git',['rev-parse','HEAD^']),BASE,'Unexpected baseline; no writes');
const api='src/lib/api/kbBinding.service.ts';
const ui='src/routes/_authenticated/console.settings.kb-binding.tsx';
const tests='tests/console-navigation/kb-binding-dev.test.mjs';
const gate='.github/scripts/c3_unified_production_source_gate.mjs';
const profile='.github/scripts/c3_unified_production_profile.json';
const read=p=>fs.readFileSync(p,'utf8');
const old={}; for(const p of [api,ui,tests,gate,profile])old[p]=read(p);
assert.equal(run('git',['hash-object',api]),'43588f74c246478cef8e972cc84502f8be7077a2');
assert.equal(run('git',['hash-object',ui]),'40091911565158b1c6590db3054315899f4dddfe');
const once=(s,a,b)=>{assert.equal(s.split(a).length,2,`Exact preimage missing: ${a.slice(0,100)}`);return s.replace(a,b);};
let a=old[api];
a=once(a,'  writer_ready: boolean;','  writer_ready: boolean;\n  binding_write_eligible: boolean;');
a=once(a,'  const value = process.env.C3_KB_BINDING_ADMIN_KEY ||\n    process.env.SUPABASE_SECRET_KEY ||\n    process.env.SUPABASE_SERVICE_ROLE_KEY;','  const value = process.env.C3_KB_BINDING_ADMIN_KEY;');
a=once(a,'      "C3_KB_BINDING_ADMIN_KEY", "SUPABASE_SECRET_KEY",\n      "SUPABASE_SERVICE_ROLE_KEY",','      "C3_KB_BINDING_ADMIN_KEY",');
a=once(a,' * or backend. The platform\'s managed SERVICE_ROLE_KEY is a supported server\n * alias; neither name is ever placed in a VITE_ variable or returned to UI.',' * or backend. Only the explicitly project-bound C3_KB_BINDING_ADMIN_KEY is used\n * for Auth administration; platform-owned foreign-project keys are not a fallback.');
const anchor='    return { ok: true, data: owned.data.map((co) => {\n      const b = (bindings ?? []).find((x: any) => x.company_id === co.id);';
a=once(a,anchor,`    // A deployed, non-writing RPC probe proves this user's exact eligibility.
    // RLS SELECT alone is not write permission; this is not a claimed Save.
    const selfEligible = new Set<string>();
    await Promise.all(owned.data.map(async (co) => {
      try {
        const { data: probe, error: probeError } = await (context.supabase as any)
          .rpc("kb_binding_write_self_v1", {
            p_company: co.id, p_tenant: "50", p_kb_company: null,
            p_active: false, p_expected_revision: 0, p_new_key: null, p_probe: true,
          });
        if (!probeError && probe?.contract === "kb-binding-self-v1" &&
            probe?.eligible === true && probe?.company_id === co.id &&
            probe?.actor_id === String(context.userId)) selfEligible.add(co.id);
      } catch { /* fail closed; never manufacture write readiness */ }
    }));
${anchor}`);
a=once(a,'        writer_status: writerStatus,','        writer_status: writerStatus,\n        binding_write_eligible: selfEligible.has(co.id),');
a=once(a,'    has_key: false, writer_ready: false,','    has_key: false, writer_ready: false, binding_write_eligible: false,');
const writeStart=a.indexOf('    // Secrets go ONLY into the existing protected service_role SQL');
const writeEnd=a.indexOf('\nconst inviteInput =',writeStart);
assert(writeStart>0&&writeEnd>writeStart);
a=a.slice(0,writeStart)+`    // B: user JWT reaches the narrow same-Company wrapper. No Admin key,
    // caller-selected actor, direct table write or Vault plaintext permission.
    const { data: output, error } = await (context.supabase as any).rpc("kb_binding_write_self_v1", {
      p_company: data.company_id, p_tenant: data.kb_tenant_id,
      p_kb_company: data.kb_company_id, p_active: data.is_active,
      p_expected_revision: data.expected_revision, p_new_key: data.api_key ?? null,
      p_probe: false,
    });
    if (error || !output || output.company_id !== data.company_id ||
        output.kb_tenant_id !== data.kb_tenant_id || output.is_active !== data.is_active ||
        Number(output.revision) !== data.expected_revision + 1 ||
        (data.is_active && output.has_key !== true)) {
      const code = String(error?.message ?? "");
      return { ok: false, error: code.includes("KB_BINDING_REVISION_CONFLICT")
        ? "binding_revision_conflict_reload" : code.includes("KB_BINDING_SELF_SCOPE_DENIED")
        ? "binding_development_scope_denied" : "binding_save_unconfirmed_reload_before_retry" };
    }
    // Do not retry an unknown commit. Read back only allowed metadata through
    // the same user's RLS and require the exact post-image before success.
    const { data: row, error: readError } = await (context.supabase as any)
      .from("company_kb_tenant_binding")
      .select("company_id,kb_tenant_id,kb_company_id,is_active,revision")
      .eq("company_id", data.company_id).maybeSingle();
    if (readError || row?.kb_tenant_id !== data.kb_tenant_id ||
        row?.company_id !== data.company_id || row?.is_active !== data.is_active ||
        (row?.kb_company_id ?? null) !== data.kb_company_id ||
        Number(row?.revision) !== Number(output.revision)) {
      return { ok: false, error: "binding_commit_readback_unconfirmed_reload_before_retry" };
    }
    return { ok: true, data: {
      company_id: row.company_id, kb_tenant_id: row.kb_tenant_id,
      revision: Number(row.revision), has_key: output.has_key === true,
      is_active: row.is_active === true,
    } };
  });
`+a.slice(writeEnd);
let u=old[ui];
u=u.replace('phase === "ready" && !current.writer_ready && " · Protected writer not available"','phase === "ready" && !current.binding_write_eligible && " · KB Save route unavailable"');
u=once(u,'if (!current || action || !verifiedLogin || !current.writer_ready) {','if (!current || action || !verifiedLogin || !current.binding_write_eligible) {');
u=once(u,'Select a verified login and Company with an available protected server writer.','Select a verified login and Company eligible for the authenticated KB save route.');
u=u.split('phase === "ready" && current && !current.writer_ready').join('phase === "ready" && current && !current.binding_write_eligible');
const warningStart=u.indexOf('          Company/KB metadata is verified through your real Supabase Auth');
const warningEnd=u.indexOf('\n        </p>}',warningStart);
assert(warningStart>0&&warningEnd>warningStart);
u=u.slice(0,warningStart)+`          The authenticated KB save route has not confirmed eligibility for this Company.
          No save has occurred. Check the signed-in Admin, the deployed scoped wrapper and
          the active Company/Channel; do not enter a Supabase management key in this form.`+u.slice(warningEnd);
u=u.replace('Recheck protected server writer','Recheck authenticated Save eligibility');
const buttonOld='          <button type="button" disabled={!current || phase !== "ready" || !current?.writer_ready || Boolean(action) || !verifiedLogin || !current?.channels_ready || !/^[1-9]\\d{0,15}$/.test(tenant) || (active && !current?.has_key && key.length < 16)}';
const buttonNew='          <button id="kb-binding-save" type="button" aria-describedby="kb-binding-save-help" style={{ padding: "12px 18px", borderRadius: 8, border: "1px solid #475569", fontWeight: 700, background: current?.binding_write_eligible ? "#1d4ed8" : "#e2e8f0", color: current?.binding_write_eligible ? "#fff" : "#334155", cursor: current?.binding_write_eligible ? "pointer" : "not-allowed" }} disabled={!current || phase !== "ready" || !current?.binding_write_eligible || Boolean(action) || !verifiedLogin || !current?.channels_ready || !/^[1-9]\\d{0,15}$/.test(tenant) || (active && !current?.has_key && key.length < 16)}';
u=once(u,buttonOld,buttonNew);
const buttonClose='            {action === "saving" ? "Saving…" : "Save Company → KB binding (CAS)"}\n          </button>';
u=once(u,buttonClose,buttonClose+`\n          <p id="kb-binding-save-help" role="status" style={{ fontSize: 13 }}>
            {current?.binding_write_eligible
              ? "Authenticated save route available. Select the verified login, enter KB ID and key, then Save. Only an exact server commit and readback count as saved."
              : "Save is unavailable until the signed-in Admin is eligible for the deployed authenticated route."}
          </p>`);
// Account-creation controls retain their separate privileged-key requirements.
let t=old[tests];
t=t.replace('assert.doesNotMatch(handler, /is_active:\\s*false/);','assert.doesNotMatch(handler.slice(handler.indexOf("const inviteInput ="), handler.indexOf("export async function listAuthorizedCompanyScopesReadOnly")), /is_active:\\s*false/);');
t=t.replace('assert.match(route, /disabled=\\{phase !== "ready" \\|\\| Boolean\\(action\\)/);','assert.match(route, /disabled=\\{phase !== "ready" \\|\\| !current\\.writer_ready \\|\\| Boolean\\(action\\)/);');
t=t.replaceAll('assert.match(source, /process\\.env\\.SUPABASE_SECRET_KEY \\|\\|/);','assert.doesNotMatch(source, /process\\.env\\.SUPABASE_SECRET_KEY/);');
t=t.replaceAll('assert.match(source, /process\\.env\\.SUPABASE_SERVICE_ROLE_KEY/);','assert.doesNotMatch(source, /process\\.env\\.SUPABASE_SERVICE_ROLE_KEY/);');
t=t.replaceAll('assert.match(src, /process\\.env\\.C3_KB_BINDING_ADMIN_KEY \\|\\|/);','assert.match(src, /process\\.env\\.C3_KB_BINDING_ADMIN_KEY;/);');
t=t.replaceAll('assert.match(src, /process\\.env\\.SUPABASE_SECRET_KEY \\|\\|/);','assert.doesNotMatch(src, /process\\.env\\.SUPABASE_SECRET_KEY/);');
t=t.replaceAll('assert.match(src, /process\\.env\\.SUPABASE_SERVICE_ROLE_KEY/);','assert.doesNotMatch(src, /process\\.env\\.SUPABASE_SERVICE_ROLE_KEY/);');
t=t.replace('assert.match(source, /protected_kb_writer_unavailable/);','assert.match(source, /binding_save_unconfirmed_reload_before_retry/);');
t=t.replaceAll('assert.match(route, /Company\\/KB metadata is verified through your real Supabase Auth/);','assert.match(route, /authenticated KB save route has not confirmed eligibility/);');
t=t.replaceAll('assert.match(route, /The protected server writer is unavailable/);','assert.match(route, /No save has occurred/);');
t=t.replaceAll('!current\\?\\.writer_ready','!current\\?\\.binding_write_eligible');
t=t.replace('assert.match(src, /current\\.writer_status === "server_credential_unavailable"/);','assert.match(src, /!current\\.binding_write_eligible/);');
t=t.replace('assert.match(src, /configure C3_KB_BINDING_ADMIN_KEY as a server-only secret/);','assert.match(src, /do not enter a Supabase management key/);');
t=t.replace('assert.match(src, /Recheck protected server writer/);','assert.match(src, /Recheck authenticated Save eligibility/);');
t=t.replaceAll('[^\\\\n]*type="password"','[^\\n]*type="password"');
const migrations=fs.readdirSync('supabase/migrations').filter(x=>/^\d+_task3c_kb_binding_authenticated_save\.sql$/.test(x));
assert.equal(migrations.length,1,'CLI must generate exactly one migration');
const migration=`supabase/migrations/${migrations[0]}`;
const rollback=`supabase/migrations/rollback/${migrations[0].replace('.sql','.rollback.sql')}`;
const sql=read('.github/scripts/task3c-kb-self.sql');
const rollbackSql=`-- Disable only the new authenticated entry point; preserve all original data.\nBEGIN;\nREVOKE ALL ON FUNCTION public.kb_binding_write_self_v1(uuid,text,text,boolean,bigint,text,boolean) FROM PUBLIC,anon,authenticated;\nDROP FUNCTION public.kb_binding_write_self_v1(uuid,text,text,boolean,bigint,text,boolean);\nCOMMIT;\n`;
t+=`\ntest("B authenticated Save uses current JWT with no actor override and verifies readback", () => {
 const save = handler.slice(handler.indexOf("export const saveKBDevBindingFn"),handler.indexOf("const inviteInput ="));
 assert.ok(save.includes('(context.supabase as any).rpc("kb_binding_write_self_v1"'));
 assert.ok(!save.includes('kbBindingAdminClient('));
 assert.ok(!save.includes('p_actor:'));
 assert.ok(save.includes('p_expected_revision: data.expected_revision'));
 assert.ok(save.includes('binding_commit_readback_unconfirmed_reload_before_retry'));
 assert.ok(route.includes('id="kb-binding-save"'));
 assert.ok(route.includes('!current?.binding_write_eligible'));
 const wrapper = read(${JSON.stringify(migration)});
 for(const required of ['auth.uid()', "SET search_path = ''",'KB_BINDING_SELF_SCOPE_DENIED','p_probe','pg_advisory_xact_lock','public.kb_binding_write_v1','FROM PUBLIC, anon','TO authenticated']) assert.ok(wrapper.includes(required),required);
 assert.ok(!wrapper.includes('GRANT SELECT'));
 assert.ok(!wrapper.includes('CREATE TABLE'));
 assert.ok(!wrapper.includes('p_actor uuid'));
 const rb=read(${JSON.stringify(rollback)}); assert.ok(!rb.includes('DELETE FROM'));
});\n`;
const changed={[api]:a,[ui]:u,[tests]:t,[migration]:sql,[rollback]:rollbackSql};
const mapMatch=old[gate].match(/const TASK3C_KB_BINDING_SOURCE=Object\.freeze\((\{[^\n]*\})\);/);
assert(mapMatch); const pins=JSON.parse(mapMatch[1]); const p=JSON.parse(old[profile]);
assert.deepEqual(pins,p.authorized_task3c_kb_binding_sha256);
for(const file of [api,ui,tests])assert.equal(pins[file],sha(old[file]),`Prior pinned hash mismatch ${file}`);
for(const [file,content] of Object.entries(changed))pins[file]=sha(content);
changed[gate]=once(old[gate],mapMatch[0],'const TASK3C_KB_BINDING_SOURCE=Object.freeze('+JSON.stringify(pins)+');');
p.authorized_task3c_kb_binding_sha256=pins;
for(const flag of ['task3c_kb_binding_production_authorized','task3c_kb_binding_publish_authorized','task3c_kb_binding_schema_authorized','task3c_kb_binding_paid_traffic_authorized'])assert.equal(p[flag],false);
changed[profile]=JSON.stringify(p,null,2)+(old[profile].endsWith('\n')?'\n':'');
assert(!a.includes('process.env.SUPABASE_SERVICE_ROLE_KEY'));
assert(!a.includes('process.env.SUPABASE_SECRET_KEY'));
for(const [file,content] of Object.entries(changed)){fs.mkdirSync(file.slice(0,file.lastIndexOf('/')),{recursive:true});fs.writeFileSync(file,content);}
fs.writeFileSync('/tmp/task3c-exact-paths',Object.keys(changed).join('\n')+'\n');
console.log(JSON.stringify({baseline:BASE,paths:Object.entries(changed).map(([path,content])=>({path,sha256:sha(content)})),source_only:true},null,2));
