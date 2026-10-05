import assert from "node:assert/strict";
import fs from "node:fs";
import { transform, build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as production from "../../src/integrations/supabase/runtime-authority.mjs";
import * as nonproduction from "../../src/integrations/supabase/nonproduction-authority.mjs";
const compiled = await transform(
  fs.readFileSync("src/components/console/handoff-summary.ts", "utf8"),
  { loader: "ts", format: "esm" },
);
const { projectTicketSummary } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.code).toString("base64")
);
const result = await build({
  entryPoints: ["src/components/console/TicketHandoffSummary.tsx"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  packages: "external",
  plugins: [
    {
      name: "supabase-test-boundary",
      setup(b) {
        b.onResolve({ filter: /^@\/integrations\/supabase\/client$/ }, () => ({
          path: "client",
          namespace: "fixture",
        }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: "export const supabase = {};",
        }));
      },
    },
  ],
});
const renderedFile = "tests/phase1/.summary-renderer.mjs";
fs.writeFileSync(renderedFile, result.outputFiles[0].text);
try {
  const { TicketSummaryView } = await import("./.summary-renderer.mjs");
  const envelope = JSON.parse(
    fs.readFileSync("tests/phase1/persisted-handoff.fixture.json", "utf8"),
  );
  const p = envelope.structured_package;
  const summary = projectTicketSummary(envelope, p.conversation_id, p.company_id);
  assert.ok(summary);
  const html = renderToStaticMarkup(React.createElement(TicketSummaryView, { summary }));
  for (const truth of [
    "真人接手摘要",
    "110平方呎",
    "80平方呎",
    "180平方呎",
    "大房",
    "下午西曬",
    "595",
    "已暫緩",
    "3/4匹",
    "4000",
    "歷史",
    "報價",
    "未建立",
    "stock",
  ])
    assert.ok(html.includes(truth), truth);
  for (const internal of [
    "commerce_state_revision",
    "container_quantity",
    "system_default",
    "resolver",
    "B2",
    "d4000000",
    "air_conditioner:unscoped",
    "hash",
  ])
    assert.ok(!html.includes(internal), internal);
  assert.ok(!html.includes("1 部（客人確認）"));
  assert.equal(projectTicketSummary(envelope, "foreign", p.company_id), null);
  assert.equal(projectTicketSummary(envelope, p.conversation_id, "foreign"), null);
  assert.equal(projectTicketSummary("invalid", p.conversation_id, p.company_id), null);
  const altered = structuredClone(envelope);
  altered.structured_package.current_authoritative_kb_facts[0].currentness_at_answer = "stale";
  assert.ok(
    projectTicketSummary(altered, p.conversation_id, p.company_id).find(
      (s) => s.title === "已核實產品資料",
    ).lines.length < summary.find((s) => s.title === "已核實產品資料").lines.length,
  );
  const quantity = structuredClone(envelope);
  quantity.structured_package.active_entities[0].quantity = 3;
  quantity.structured_package.active_entities[0].attributes.quantity_basis = "customer_explicit";
  assert.ok(
    projectTicketSummary(quantity, p.conversation_id, p.company_id)
      .find((s) => s.title === "目前需求")
      .lines.includes("冷氣：3（客人確認）"),
  );
  for (const [goal, category, count, attributes, expected] of [
    ["冷氣維修及售後檢查", "air_conditioner", null, {}, "冷氣：數量未確認"],
    ["補充紙張", "paper", 12, { quantity_basis: "customer_explicit", unit: "包" }, "paper：12 包（客人確認）"],
    ["核對文件", "document", null, {}, "document：數量未確認"],
  ]) {
    const generic = structuredClone(envelope);
    generic.structured_package.current_customer_goal = goal;
    generic.structured_package.active_entities = [{ category, quantity: count, attributes }];
    const projected = projectTicketSummary(generic, p.conversation_id, p.company_id);
    assert.deepEqual(projected.find(s => s.title === "客人目標").lines, [goal]);
    assert.deepEqual(projected.find(s => s.title === "目前需求").lines, [expected]);
    assert.ok(!JSON.stringify(projected).includes("選購"));
  }
  const deferred = structuredClone(envelope);
  deferred.structured_package.active_entities.push({ category: "paper", status: "deferred", quantity: 12, attributes: { quantity_basis: "customer_explicit", unit: "包" } });
  assert.ok(!JSON.stringify(projectTicketSummary(deferred, p.conversation_id, p.company_id).find(s => s.title === "目前需求")).includes("paper"));
  for (const bad of ["https://example.com", "https://nrfxhqabwblzxoushgnm.supabase.co"])
    assert.throws(() => nonproduction.assertAuthoritativeSupabaseRuntime(bad));
  assert.equal(
    nonproduction.resolveAuthoritativeSupabaseBinding({
      url: "https://evil.com",
      projectId: "evil",
      publishableKey: "service_role",
    }).projectId,
    "nbtowfuvvfqpxqydyoby",
  );
  assert.equal(
    production.resolveAuthoritativeSupabaseBinding({
      url: nonproduction.AUTHORITATIVE_SUPABASE_ORIGIN,
    }).projectId,
    "nrfxhqabwblzxoushgnm",
  );
  assert.throws(() =>
    nonproduction.assertAuthoritativeFunctionsRuntime("https://example.com/functions/v1"),
  );
  for (const filename of [
    "src/routes/_authenticated/console.conversations.index.tsx",
    "src/routes/_authenticated/console.conversations.$id.tsx",
  ])
    assert.ok(fs.readFileSync(filename, "utf8").includes("<TicketHandoffSummary"));
  const replyModule = await transform(
    fs.readFileSync("src/components/console/reply-request.ts", "utf8"),
    { loader: "ts", format: "esm" },
  );
  const { ReplyRequest } = await import(
    "data:text/javascript;base64," + Buffer.from(replyModule.code).toString("base64")
  );
  const req = new ReplyRequest(),
    a = req.body("one", " message "),
    b = req.body("one", "message");
  assert.equal(a.client_request_id, b.client_request_id);
  assert.equal(a.content, "message");
  req.confirmed("different");
  assert.equal(req.body("one", "message").client_request_id, a.client_request_id);
  const other = req.body("two", "message");
  assert.notEqual(a.client_request_id, other.client_request_id);
  req.confirmed(a.client_request_id);
  assert.equal(req.body("two", "message").client_request_id, other.client_request_id);
  req.confirmed(other.client_request_id);
  assert.notEqual(req.body("two", "message").client_request_id, other.client_request_id);
  assert.notEqual(req.body("two", "changed").client_request_id, other.client_request_id);
  console.log(
    "PASS: persisted Summary React rendering, tenant binding, truth/provenance, build-selected environment guards",
  );
} finally {
  fs.unlinkSync(renderedFile);
}
