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
  check(!git("status", "--porcelain", "--untracked-files=all"), "clean committed candidate");
  check(
    JSON.stringify(git("diff", "--name-only", baseline, "HEAD").split("\n").sort()) ===
      JSON.stringify(allowed),
    "exact directly implicated file scope",
  );
  const closure = runtimeDependencyClosure({
    root: process.cwd(),
    entrypoints: ["supabase/functions/generate-reply/index.ts"],
  });
  for (const file of closure.files ?? closure)
    check(
      sha(readFileSync(file)) === sha(execFileSync("git", ["show", `${baseline}:${file}`])),
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
