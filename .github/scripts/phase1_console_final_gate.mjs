#!/usr/bin/env node
// Read-only acceptance gate. API/SSR evidence never substitutes for real Console actions.
// Usage: node .github/scripts/phase1_console_final_gate.mjs --head SHA --tree SHA --evidence /absolute/observed.json
// --source-only validates the committed source boundary only, never Demo Ready.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { transform } from "esbuild";
import { runtimeDependencyClosure } from "./c3_module_graph.mjs";
import { resolveAuthoritativeSupabaseBinding } from "../../src/integrations/supabase/nonproduction-authority.mjs";
const baseline = "f71e6013db21a5280cbc41b22f5ae7da5b7623d0";
const project = "nbtowfuvvfqpxqydyoby";
const allowed = [
  ".github/scripts/c3_director_candidate_scope.json",
  ".github/scripts/phase1_console_final_gate.mjs",
  ".github/workflows/task-ai-abc-c3-final-gate.yml",
  "sql/phase1-console/agent-reply-idempotency.rollback.sql",
  "sql/phase1-console/agent-reply-idempotency.sql",
  "sql/phase1-console/console-tenant-reads.rollback.sql",
  "sql/phase1-console/console-tenant-reads.sql",
  "src/components/console/TicketHandoffSummary.tsx",
  "src/components/console/handoff-summary.ts",
  "src/components/console/reply-request.ts",
  "src/integrations/supabase/nonproduction-authority.mjs",
  "src/routes/_authenticated/console.conversations.$id.tsx",
  "src/routes/_authenticated/console.conversations.index.tsx",
  "src/routes/_authenticated/console.tsx",
  "src/routes/login.tsx",
  "supabase/functions/agent-send-reply/index.ts",
  "supabase/functions/generate-reply/index.ts",
  "supabase/functions/_shared/conversation-service-planner.ts",
  "supabase/functions/_shared/conversation-service-planner.test.ts",
  "supabase/functions/_shared/pre-send-conversion-supervisor.test.ts",
  "supabase/functions/_shared/pre-send-conversion-supervisor.ts",
  "supabase/functions/_shared/natural-customer-response.ts",
  "supabase/functions/_shared/natural-customer-response.test.ts",
  "tests/phase1/console-summary.test.mjs",
  "tests/phase1/persisted-handoff.fixture.json",
  "vite.config.ts",
].sort();
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sha = (x) => createHash("sha256").update(x).digest("hex");
const read = (p) => readFileSync(p, "utf8");
const arg = (k) => process.argv[process.argv.indexOf(k) + 1];
let assertions = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  assertions++;
};
async function verifyActualEntrypoint(e, head, tree) {
  check(e.project_id === project && e.head === head && e.tree === tree, "entrypoint exact candidate");
  check(e.binding.project_id === project && e.binding.mock_auth === false, "real nonproduction binding");
  const html = read(e.binding.served_html);
  check(html.includes("NONPRODUCTION") && html.includes(project) && html.includes(head) && html.includes(tree) && !html.includes("WORKTREE MODIFIED"), "served customer build identity");
  check(html.includes('/widget/chat.js') && html.includes(`${project}.supabase.co/functions/v1`), "existing real customer Widget");
  for (const target of ["browser", "ssr", "auth", "reads_writes", "ingress", "generate", "takeover", "reply"])
    check(e.binding.authority[target] === project, `entrypoint authority: ${target}`);
  for (const caseName of ["hello_zh", "hello_en", "help_zh", "help_cantonese", "help_en"]) {
    const c = e.cases[caseName], m = c.reply.metadata;
    check(c.ingress.status === 200 && c.poll_status === 200, `${caseName} real ingress and polling`);
    check(m.response_route === "natural_greeting" && m.handoff_required === false && m.commerce_state_persistence_classification === "NO_SEMANTIC_CHANGE", `${caseName} natural opening and no transaction mutation`);
    check(!/現行資料|日期|適用範圍|待核實|no.match/i.test(c.reply.content), `${caseName} useful greeting`);
  }
  check(e.cases.fact.reply.content.includes("3/4匹") && e.cases.fact.reply.metadata.citations.length > 0, "S3 grounded factual answer");
  check(e.cases.guidance.reply.metadata.natural_intent === "product_guidance" && /room|area/i.test(e.cases.guidance.reply.content), "S3 business intent retained");
  check((e.cases.context.reply.content.includes("CW-SUL70BA") || e.cases.context.reply.content.includes("80平方呎")) && !/數量：1|重新.*型號|提供.*型號/.test(e.cases.context.reply.content), "S4 known context and quantity provenance");
  check(e.cases.clarify.reply.metadata.response_route === "product_referent_clarification", "S5 minimum useful clarification");
  const answered = e.cases.requery;
  check(answered.input === "CW-SUL70BA" && answered.reply.content.includes("3/4") && answered.reply.metadata.citations.length > 0, "S5 new information yields grounded answer");
  check(e.retrieval.request.includes("CW-SUL70BA") && e.retrieval.request !== e.cases.clarify.input && e.retrieval.returned_chunk.id === answered.reply.metadata.citations[0].chunk_id && e.retrieval.returned_chunk.chunk_text.includes("3/4匹"), "S5 actual changed retrieval and returned evidence");
  check(e.retrieval.observation_path && read(e.retrieval.observation_path).includes(e.retrieval.request), "S5 retrieval request observation");
  check(e.cases.unknown.reply.metadata.response_route === "kb_no_current_evidence" && !/提供.*型號|日期|適用範圍/.test(e.cases.unknown.reply.content), "S6 honest known-model unknown");
  check(e.handoff.conversation_id === e.ids.conversation && e.queue.conversation_id === e.ids.conversation && e.queue.company_id === e.ids.company && e.queue.state === "waiting", "S7 same-ticket real handoff");
  const compiled = await transform(read("src/components/console/handoff-summary.ts"), { loader: "ts", format: "esm" });
  const { projectTicketSummary } = await import("data:text/javascript;base64," + Buffer.from(compiled.code).toString("base64"));
  const summary = projectTicketSummary(e.handoff.ai_summary, e.ids.conversation, e.ids.company);
  check(summary !== null, "same-company canonical Summary");
  const text = JSON.stringify(summary);
  for (const t of ["110平方呎", "80平方呎", "180平方呎", "下午西曬", "595", "已暫緩", "3/4匹", "4000", "不是現價", "未建立", "stock"])
    check(text.includes(t), `current Demo Summary: ${t}`);
  check(!/system_default|commerce_state_revision|resolver|B2/.test(text), "Summary excludes internals");
  for (const f of e.deployed_sources) check(f.sha256 === sha(readFileSync(f.repo_path)), `exact live source: ${f.repo_path}`);
  const target = JSON.parse(read(e.target_manifest_path));
  check(target.head === head && target.tree === tree && target.project_id === project, "actual successor deployment target identity");
  for (const name of ["generate_reply", "agent_assist"]) {
    const actual = e.runtime[name], expected = target.runtime[name];
    check(actual.status === "ACTIVE" && actual.version === expected.version && actual.ezbr_sha256 === expected.ezbr_sha256 && actual.verify_jwt === true && actual.import_map === false, `successor runtime source/config identity: ${name}`);
  }
  const contextual = e.readable_projection;
  check(contextual.head === head && contextual.tree === tree && contextual.reply_id === e.cases.context.reply.id, "S4 successor persisted reply binding");
  const reply = e.cases.context.reply.content;
  check(reply.includes("冷氣機") && !/(?:查詢項目：air_conditioner|select_product|window_opening_check)/.test(reply) && !/你想我幫你跟進邊一部分/.test(reply), "S4 localized goal-aware customer text");
  check(/闊度|高度/.test(reply) && !/已查庫存|已安排|已報價|已轉交/.test(reply), "S4 useful unresolved check without completed promises");
  check(contextual.before.state_hash === contextual.after.state_hash && contextual.before.revision === contextual.after.revision && JSON.stringify(contextual.before.state) === JSON.stringify(contextual.after.state), "S4 renderer leaves authoritative semantic state unchanged");
  check(read(contextual.raw_reply_path).includes(reply), "S4 actual hosted persisted text observation");
  const generic = e.generic_projection;
  check(generic.head === head && generic.tree === tree && generic.reply_id === generic.reply.id, "generic successor persisted reply binding");
  const entity = generic.before.state.entities.find(x => x.attributes.product_name);
  check(entity && generic.reply.content.includes(entity.attributes.product_name) && generic.reply.content.includes(entity.model ?? entity.attributes.sku), "generic trusted name and exact SKU are visible");
  check(!/item not confirmed|項目未確認|generic_product|窗口|window|professional|專業/.test(generic.reply.content), "generic item does not inherit household unknown or professional requirement");
  check(generic.before.state_hash === generic.after.state_hash && generic.before.revision === generic.after.revision && JSON.stringify(generic.before.state) === JSON.stringify(generic.after.state), "generic realization preserves authoritative state");
  check(read(generic.raw_reply_path).includes(generic.reply.content), "generic actual hosted persisted text observation");
  check(e.validation.b2_projection.exit_code === 0 && read(e.validation.b2_projection.log_path).includes("2 passed"), "focused missing/provided classification and contextual B2 regressions");
  check(e.production.generate_reply.version === 201 && e.production.generate_reply.ezbr_sha256 === "b60a8df3b01a5a74eca5709f4e95929cf90ee432f6c266415e0fd00f77456d32", "production unchanged");
  for (const name of ["A2", "C3"]) check(e.ci[name].head_sha === head && e.ci[name].conclusion === "success", `new HEAD exact ${name}`);
  for (const name of ["production_build", "nonproduction_build", "typecheck", "summary", "social", "service"]) check(e.validation[name].exit_code === 0, `focused validation: ${name}`);
  check(e.retained_demo.company_id === e.ids.company && e.retained_demo.conversation_id === e.ids.conversation && e.retained_demo.exclude_training === true && e.retained_demo.cleanup_path, "retained Director Demo inventory and lifecycle");
  check(e.cleanup.disposable_remaining === 0, "scoped disposable cleanup");
  if (!e.ui || e.ui.blocker) {
    console.log(JSON.stringify({ result: "STOP", head, tree, assertions, blocker: e.ui?.blocker ?? "Director-controlled Chrome actions not observed", summary_visible: "UNVERIFIED", takeover: "UNVERIFIED", suppression: "UNVERIFIED", human_reply: "UNVERIFIED" }));
    process.exit(2);
  }
  check(e.ui.project_id === project && e.ui.conversation_id === e.ids.conversation && e.ui.company_id === e.ids.company, "actual UI same-ticket tenant");
  for (const key of ["login", "customer_chat", "summary_visible", "takeover_clicked", "human_reply_sent"])
    check(e.ui[key]?.observed === true && e.ui[key].evidence_path && readFileSync(e.ui[key].evidence_path).length > 0, `actual UI: ${key}`);
  check(e.ui.takeover_clicked.channel === "console_control" && e.ui.human_reply_sent.channel === "console_composer", "intended UI controls");
  const before = e.before_suppression, after = e.after_suppression, last = e.after_reply;
  for (const s of [before, after, last]) check(s.conversation.id === e.ids.conversation && s.conversation.company_id === e.ids.company && s.conversation.status === "pending" && s.conversation.assigned_agent_id === e.ids.agent && s.queue[0].state === "assigned" && s.assignment.filter(a => a.is_active && a.agent_id === e.ids.agent).length === 1, "authoritative assigned human control");
  check(after.messages.filter(m => m.id === e.ids.suppressed_visitor && m.role === "visitor").length === 1 && e.suppressed.body.skipped === "human_handling", "one stored visitor and AI suppression");
  const ai = s => JSON.stringify(s.messages.filter(m => m.role === "assistant").map(m => m.id).sort());
  check(ai(before) === ai(after) && ai(after) === ai(last) && JSON.stringify(before.commerce) === JSON.stringify(after.commerce) && JSON.stringify(after.commerce) === JSON.stringify(last.commerce), "no AI reply or semantic mutation");
  check(last.messages.filter(m => m.id === e.ids.human_reply && m.role === "agent" && m.sender_id === e.ids.agent).length === 1 && e.customer_poll.body.data.messages.filter(m => m.id === e.ids.human_reply).length === 1 && e.retry_once.body.data.message_id === e.retry_twice.body.data.message_id, "human reply reaches customer once and retry deduplicates");
  check(e.tenant_safety.foreign_read.status === 200 && e.tenant_safety.foreign_read.body.length === 0 && e.tenant_safety.foreign_takeover.status === 404 && e.tenant_safety.foreign_reply.status === 404, "tenant isolation preserved");
  console.log(JSON.stringify({ result: "PASS", head, tree, assertions, status: "READY — PHASE 1 DEMO READY / ACTUAL ENTRYPOINT VERIFIED" }));
}
try {
  const head = git("rev-parse", "HEAD"),
    tree = git("rev-parse", "HEAD^{tree}");
  check(process.argv.includes("--head") && arg("--head") === head, "exact HEAD required");
  check(process.argv.includes("--tree") && arg("--tree") === tree, "exact TREE required");
  check(
    git("rev-parse", `${baseline}^{tree}`) === "4093aa1fb6cad926e3909e996db75913e278e458",
    "accepted baseline tree",
  );
  check(git("merge-base", baseline, "HEAD") === baseline, "same C3 ancestry");
  const sourceOffenders = git("status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter((line) => line && !(process.env.CI && line === "?? supabase/.temp/cli-latest"));
  check(sourceOffenders.length === 0, `clean committed candidate: ${JSON.stringify(sourceOffenders)}`);
  check(
    JSON.stringify(git("diff", "--name-only", baseline, "HEAD").split("\n").sort()) ===
      JSON.stringify(allowed),
    "exact directly implicated file scope",
  );
  const closure = runtimeDependencyClosure({
    root: process.cwd(),
    entrypoints: ["supabase/functions/generate-reply/index.ts"],
  });
  // Only the observed S4/S5 service projection and clarification consumers
  // are reopened. Their focused regressions and deployed parity are required.
  const missingDescriptorGuard = "      // A missing-slot identifier is a planning descriptor, not a provided value.\n      if (readOnlyProjection && /\\.attributes\\.customer_goal\\.missing\\.\\d+$/.test(fact.path)) continue;\n";
  const b2Source = "supabase/functions/_shared/pre-send-conversion-supervisor.ts";
  const variantAliases = '    color: ["color", "colour", "顏色", "颜色"],\n    version: ["version", "edition", "版本"],\n    size: ["size", "尺碼", "尺码"],\n    region: ["region", "market", "地區", "地区"],\n';
  check(read(b2Source).replace(missingDescriptorGuard, "").replace(variantAliases, "").replace("function evaluateKnownContext(text: string, state: ConversationCommerceState, readOnlyProjection: boolean = false): B2Decision | null {", "function evaluateKnownContext(text: string, state: ConversationCommerceState): B2Decision | null {").replace('evaluateKnownContext(draft, state, input.metadata?.commerce_state_persistence_classification !== "COMMITTED" && !input.trusted_journey_progress)', "evaluateKnownContext(draft, state)") === execFileSync("git", ["show", `${baseline}:${b2Source}`], {encoding:"utf8"}), "B2 rules frozen except missing descriptor/provided variant classification");
  const reopened = new Set([b2Source, "supabase/functions/_shared/conversation-service-planner.ts", "supabase/functions/_shared/natural-customer-response.ts", "supabase/functions/generate-reply/index.ts"]);
  for (const file of closure.files ?? closure)
    check(
      reopened.has(file) || sha(readFileSync(file)) === sha(execFileSync("git", ["show", `${baseline}:${file}`])),
      `frozen generate source: ${file}`,
    );
  check(
    resolveAuthoritativeSupabaseBinding().projectId === project,
    "fixed nonproduction Console binding",
  );
  execFileSync(process.execPath, ["tests/phase1/console-summary.test.mjs"], { stdio: "inherit" });
  if (process.argv.includes("--source-only")) {
    console.log(
      JSON.stringify({
        result: "PASS",
        scope: "source_only_not_demo_ready",
        head,
        tree,
        assertions,
      }),
    );
  } else {
    check(process.argv.includes("--evidence"), "runtime evidence required");
    const e = JSON.parse(read(arg("--evidence"))),
      ids = e.ids;
    if (e.schema === "phase1-entrypoint-closure-v1") {
      await verifyActualEntrypoint(e, head, tree);
      process.exit(0);
    }
    check(e.project_id === project, "nonproduction runtime identity");
    check(e.head === head && e.tree === tree, "observations bound to exact candidate");
    check(
      e.console_binding.project_id === project && !e.console_binding.mock_auth,
      "real nonproduction Console Auth binding",
    );
    check(
      e.login.status === 200 && e.login.body.authenticated && e.login.body.user_id === ids.user,
      "normal minimum-agent Auth login",
    );
    check(
      e.agent.status === "active" &&
        e.agent.role === "agent" &&
        e.agent.is_active &&
        e.agent.company_id === ids.company &&
        e.agent.membership_role === "agent",
      "active minimum-role membership",
    );
    check(
      e.ticket_read.status === 200 &&
        e.ticket_read.body.length === 1 &&
        e.ticket_read.body[0].id === ids.conversation &&
        e.ticket_read.body[0].company_id === ids.company,
      "authenticated same-company ticket read",
    );
    check(e.handoff_reply.body.handoff_persisted === true, "R1 persisted");
    const h = e.handoff,
      env = typeof h.ai_summary === "string" ? JSON.parse(h.ai_summary) : h.ai_summary;
    check(
      h.conversation_id === ids.conversation && env.structured_package.company_id === ids.company,
      "same-ticket Summary binding",
    );
    check(
      e.waiting_queue.conversation_id === ids.conversation &&
        e.waiting_queue.company_id === ids.company &&
        e.waiting_queue.state === "waiting",
      "handoff queue binding",
    );
    const module = await transform(read("src/components/console/handoff-summary.ts"), {
      loader: "ts",
      format: "esm",
    });
    const { projectTicketSummary } = await import(
      "data:text/javascript;base64," + Buffer.from(module.code).toString("base64")
    );
    const summary = projectTicketSummary(h.ai_summary, ids.conversation, ids.company),
      text = JSON.stringify(summary);
    check(Boolean(summary), "canonical Summary projectable");
    for (const t of [
      "110平方呎",
      "180平方呎",
      "80平方呎",
      "大房",
      "下午西曬",
      "已暫緩",
      "595",
      "CW-SUL70BA",
      "3/4匹",
      "4000",
      "歷史",
      "不是現價",
      "未建立",
      "stock",
    ])
      check(text.includes(t), `Summary truth: ${t}`);
    for (const t of [
      "system_default",
      "resolver",
      "B2",
      "commerce_state_revision",
      "hash",
      ids.company,
    ])
      check(!text.includes(t), `Summary excludes: ${t}`);
    check(!text.includes("1 部（客人確認）"), "default quantity not customer-confirmed");
    for (const key of ["foreign_takeover", "foreign_reply"])
      check(e[key].status === 404, `${key} tenant deny`);
    check(
      e.foreign_read.status === 200 && e.foreign_read.body.length === 0,
      "authenticated foreign ticket denied",
    );
    for (const key of [
      "no_membership_takeover",
      "no_membership_reply",
      "inactive_takeover",
      "inactive_reply",
    ])
      check(e[key].status === 403, `${key} denied`);
    check(e.no_membership_read.body.length === 0, "no membership ticket read denied");
    for (const key of ["unauthenticated_takeover", "unauthenticated_reply"])
      check(e[key].status === 401, `${key} denied`);
    check(
      e.takeover.status === 200 && e.repeat_takeover.body.already_owner === true,
      "normal endpoint takeover and idempotent repeat",
    );
    const before = e.before_suppression,
      after = e.after_suppression,
      last = e.after_reply;
    for (const s of [before, after, last]) {
      check(
        s.conversation.id === ids.conversation &&
          s.conversation.company_id === ids.company &&
          s.conversation.status === "pending" &&
          s.conversation.assigned_agent_id === ids.agent,
        "authoritative human control remains active",
      );
      check(
        s.queue[0].state === "assigned" && s.queue[0].assigned_agent_id === ids.agent,
        "queue assigned agent",
      );
      check(
        s.assignment.filter((a) => a.is_active && a.agent_id === ids.agent).length === 1,
        "one active assignment",
      );
    }
    check(
      e.suppressed.status === 200 && e.suppressed.body.skipped === "human_handling",
      "AI path recognizes human control",
    );
    check(
      after.messages.filter((m) => m.id === ids.suppressed_visitor && m.role === "visitor")
        .length === 1,
      "exactly one next visitor stored",
    );
    const assistants = (s) =>
      s.messages
        .filter((m) => m.role === "assistant")
        .map((m) => m.id)
        .sort();
    check(
      JSON.stringify(assistants(before)) === JSON.stringify(assistants(after)) &&
        JSON.stringify(assistants(after)) === JSON.stringify(assistants(last)),
      "zero new AI messages during suppression/human reply",
    );
    check(
      JSON.stringify(before.commerce) === JSON.stringify(after.commerce) &&
        JSON.stringify(after.commerce) === JSON.stringify(last.commerce),
      "no semantic Commerce mutation",
    );
    check(
      e.human_reply.status === 200 && e.human_reply.body.data.message_id === ids.human_reply,
      "normal endpoint reply accepted",
    );
    check(
      last.messages.filter(
        (m) => m.id === ids.human_reply && m.role === "agent" && m.sender_id === ids.agent,
      ).length === 1,
      "same-ticket human reply exactly once",
    );
    check(
      e.retry_once.body.data.message_id === e.retry_twice.body.data.message_id &&
        e.retry_conflict.status === 409,
      "reply retry identity and conflict",
    );
    check(
      last.messages.filter((m) => m.id === e.retry_once.body.data.message_id).length === 1,
      "reply retry one persisted message",
    );
    for (const f of e.deployed_sources)
      check(
        f.sha256 === sha(readFileSync(f.repo_path)),
        `live deployment matches source: ${f.repo_path}`,
      );
    check(
      e.runtime.generate_reply.version === 33 && e.runtime.generate_reply.status === "ACTIVE",
      "accepted nonproduction v33 retained",
    );
    check(
      e.production.generate_reply.version === 201 &&
        e.production.generate_reply.ezbr_sha256 ===
          "b60a8df3b01a5a74eca5709f4e95929cf90ee432f6c266415e0fd00f77456d32",
      "production v201 unchanged",
    );
    for (const name of ["A2", "C3"])
      check(
        e.ci[name].head_sha === head && e.ci[name].conclusion === "success",
        `exact ${name} CI`,
      );
    for (const name of ["production_build", "nonproduction_build", "typecheck"])
      check(e.validation[name].exit_code === 0, `${name} succeeds`);
    for (const name of [
      "conversations",
      "messages",
      "handoff",
      "queue",
      "assignments",
      "membership",
      "profiles",
      "learning",
      "training",
      "auth_user",
      "auth_sessions",
      "kb",
      "company",
      "audit",
    ])
      check(e.cleanup[name] === 0, `cleanup zero: ${name}`);
    // API-only proof is deliberately insufficient. These must be actual Browser observations.
    if (!e.ui || e.ui.blocker) {
      console.log(
        JSON.stringify({
          result: "STOP",
          assertions,
          head,
          tree,
          blocker: e.ui?.blocker ?? "Actual nonproduction Console UI evidence missing",
          api_checks: "PASS",
          console_summary_visible: "UNVERIFIED",
          console_takeover: "UNVERIFIED",
          console_human_reply: "UNVERIFIED",
        }),
      );
      process.exitCode = 2;
    } else {
      check(
        e.ui.project_id === project &&
          e.ui.conversation_id === ids.conversation &&
          e.ui.company_id === ids.company,
        "Browser same-ticket nonproduction identity",
      );
      for (const key of ["login", "summary_visible", "takeover_clicked", "human_reply_sent"])
        check(
          e.ui[key]?.observed === true && e.ui[key]?.evidence_path,
          `actual Console ${key} observation required`,
        );
      check(
        e.ui.takeover_clicked.channel === "console_control" &&
          e.ui.human_reply_sent.channel === "console_composer",
        "real intended Console controls",
      );
      console.log(
        JSON.stringify({
          result: "PASS",
          scope: "phase1_nonproduction_human_handoff_complete",
          assertions,
          head,
          tree,
        }),
      );
    }
  }
} catch (error) {
  console.error(JSON.stringify({ result: "FAIL", assertions, error: error.message }));
  process.exitCode = 1;
}
