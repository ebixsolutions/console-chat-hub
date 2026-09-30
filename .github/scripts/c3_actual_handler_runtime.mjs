/** Actual handler -> localhost PostgREST transport -> repository SQL in PGlite.
 * This is isolated integration coverage, NOT hosted Widget/Edge parity or Human95.
 * No intent, referent, control state, reply or handoff result is injected.
 * Install deno@2.9.6 and @electric-sql/pglite@0.3.14 in C3_TEST_TOOLS first.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const root = path.resolve(import.meta.dirname, "../..");
const tools = process.env.C3_TEST_TOOLS;
if (!tools) throw new Error("C3_TEST_TOOLS_required");
const { PGlite } = await import(path.join(tools, "node_modules/@electric-sql/pglite/dist/index.js"));
assert.equal(JSON.parse(fs.readFileSync(path.join(tools,"node_modules/@electric-sql/pglite/package.json"),"utf8")).version,"0.3.14");
assert.equal(JSON.parse(fs.readFileSync(path.join(tools,"node_modules/deno/package.json"),"utf8")).version,"2.9.6");
const db = new PGlite();
const faults = [];
let child;
let server;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const qid = (value) => { if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`unsafe_identifier:${value}`); return `"${value}"`; };
try {
  // PGlite has built-in SHA256 but no pgcrypto package. Only its digest overloads
  // are supplied here; the unchanged repository transaction SQL executes below.
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA extensions;
    CREATE FUNCTION extensions.digest(bytea,text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT sha256($1) $$;
    CREATE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT sha256(convert_to($1,'UTF8')) $$;`);
  const migrationFiles = ["sql/c3-nonproduction/00_repository_baseline.sql", "supabase/migrations/20260728093000_ce_task1.sql",
    "supabase/migrations/20260909173000_task_a1_universal_commerce_state.sql", "supabase/migrations/20260915000000_ai_abc_c2_director_closure_handoff.sql",
    "supabase/migrations/20260915040000_ai_abc_c3_director_runtime_closure.sql", "supabase/migrations/20260917062606_c3_deterministic_commerce_fts_governance.sql",
    "supabase/migrations/20260925093000_c3_t11_revision_bound_ai_reply.sql", "supabase/migrations/20260928100000_c3_director_handoff_context.sql", "supabase/migrations/20260930090000_c3_handoff_grounded_facts.sql"];
  let acceptedHandoff, acceptedTriggers;
  await db.exec("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text primary key,name text); INSERT INTO supabase_migrations.schema_migrations VALUES('local-baseline','isolated ledger sentinel')");
  const ledger = async ()=>(await db.query("SELECT * FROM supabase_migrations.schema_migrations ORDER BY version")).rows;
  const acceptedLedger=await ledger();
  const triggers = async ()=>(await db.query(`SELECT tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='handoff_event' AND NOT t.tgisinternal ORDER BY tgname`)).rows;
  const catalog = async () => (await db.query(`SELECT p.proname,md5(pg_get_functiondef(p.oid)) AS hash,pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.proconfig,p.proacl::text AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('commit_ai_reply_tx','c2_populate_handoff_package_tg','c3_enrich_handoff_from_memory_tg') ORDER BY p.proname`)).rows;
  for (const file of migrationFiles) {
    if(file.endsWith("20260930090000_c3_handoff_grounded_facts.sql")) {acceptedHandoff=await catalog();acceptedTriggers=await triggers();}
    await db.exec(read(file).replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/gi, ""));
  }
  const forwardCatalog=await catalog();
  for (const fn of forwardCatalog) {
    assert.equal(fn.owner,"postgres");assert.equal(fn.prosecdef,true);
    assert.deepEqual(fn.proconfig,fn.proname === "c3_enrich_handoff_from_memory_tg" ? ['search_path=""'] : ["search_path=public, pg_temp"]);
    assert.equal(fn.acl,acceptedHandoff.find(x=>x.proname===fn.proname).acl);
  }
  assert.equal(forwardCatalog.find(x=>x.proname==="commit_ai_reply_tx").hash,"f3ba6240d2453729ce073b7e87ed665c");
  assert.deepEqual(await triggers(),acceptedTriggers);assert.deepEqual(await ledger(),acceptedLedger);
  assert.deepEqual(forwardCatalog.filter(x=>x.proname!=="c3_enrich_handoff_from_memory_tg"),acceptedHandoff.filter(x=>x.proname!=="c3_enrich_handoff_from_memory_tg"));
  // Existing R1 RPC readback in the repository, not a fabricated test handoff.
  const handoffSQL = read("sql/c3-nonproduction/06_director_handoff_runtime_test.sql");
  await db.exec(handoffSQL.slice(handoffSQL.indexOf("CREATE OR REPLACE FUNCTION public.explicit_handoff_tx"), handoffSQL.indexOf("CREATE TEMP TABLE c3_before")));
  // Original app column, absent from the minimal repository bootstrap.
  await db.exec("ALTER TABLE conversations ADD COLUMN metadata_source jsonb DEFAULT '{}'::jsonb");
  await db.exec(`CREATE TABLE ce_evaluation_state(conversation_id uuid, company_id uuid, state text,
    last_success_evaluation_id uuid,last_success_source text,last_success_fingerprint text,
    current_evaluation_fingerprint text,last_success_at timestamptz,last_activity_at timestamptz);`);
  const company = randomUUID();
  await db.query("INSERT INTO company(id,slug,display_name,external_workspace_id,external_tenant_id) VALUES($1,'quality-local','Synthetic quality test','local','local')", [company]);
  const kbDoc=randomUUID(),kbChunk=randomUUID();
  const fixtureText=JSON.parse(read("supabase/functions/_shared/product-factual-query.test.ts").match(/const content =\s*("[^\n]+");/)[1]);
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const params = [];
    const bind = (value) => { params.push(value); return `$${params.length}`; };
    try {
      const body = JSON.parse((await Array.fromAsync(req)).map((part) => part.toString()).join("") || "{}");
      if (url.pathname === "/api/v1/rag/context-search") {
        assert.equal(body.company_id,34,"synthetic upstream tenant binding");
        const found=/CW-SUL70BA|ZZ-KL88|CN-314|BK-827/i.test(body.query ?? "");
        const model=(body.query ?? "").match(/CW-SUL70BA|ZZ-KL88|CN-314|BK-827/i)?.[0] ?? "CW-SUL70BA";
        const policy=/CN-314|BK-827/.test(model);
        const content = model === "CN-314" ? "product model: CN-314\nbilling policy: Seat charges are calculated monthly; changes require account administrator approval" : model === "BK-827" ? "product model: BK-827\nbooking policy: Requested dates require staff confirmation before a booking is confirmed" : fixtureText.replaceAll("CW-SUL70BA",model);
        const selected=found ? [{ document_id:kbDoc,title:`Synthetic ${model}`,source_type:policy?"policy":"product",document_score:0.99,summary:null,
          evidence:[{chunk_id:kbChunk,content,score:0.99,chunk_type:"full_content"}],
          authority:{tenant_id:"34",publication_state:"published",currentness:"current",entity_ids:[model],regions:["HK"],language:"zh-HK",version:"fixture-1",version_rank:1,updated_at:"2026-09-30T00:00:00Z",source_priority:1,claims:[]} }] : [];
        res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({success:true,context_found:found,selected_documents:selected,citations:[]}));return;
      }
      const route = url.pathname.replace(/^\/rest\/v1\//, "");
      let result;
      if (route.startsWith("rpc/")) {
        const fn = route.slice(4);
        const args = Object.entries(body).map(([key, value]) => `${qid(key)} := ${bind(typeof value === "object" && value !== null ? JSON.stringify(value) : value)}`);
        const query = `SELECT * FROM public.${qid(fn)}(${args.join(",")})`;
        const rows = (await db.query(query, params)).rows;
        result = rows.length && Object.keys(rows[0]).length === 1 && fn in rows[0] ? rows[0][fn] : rows;
      } else {
        const table = `public.${qid(route)}`;
        const filters = [];
        const logical = (raw, joiner) => {
          const inner = raw.replace(/^\(/," ").replace(/\)$/," ").trim();
          let depth=0,start=0;const parts=[];
          for(let i=0;i<inner.length;i++){if(inner[i]==="(")depth++;if(inner[i]===")")depth--;if(inner[i]==="," && depth===0){parts.push(inner.slice(start,i));start=i+1;}}
          parts.push(inner.slice(start));
          return "("+parts.map((part)=>{
            if(part.startsWith("and("))return logical(part.slice(3),"AND");
            if(part.startsWith("or("))return logical(part.slice(2),"OR");
            const match=part.match(/^([a-z_]+)\.(eq|lt|lte|gt|gte)\.(.*)$/);
            if(!match)throw new Error("unsupported_logical_filter");
            return `${qid(match[1])} ${{eq:"=",lt:"<",lte:"<=",gt:">",gte:">="}[match[2]]} ${bind(match[3])}`;
          }).join(` ${joiner} `)+")";
        };
        const column = (key) => key.includes("->>") ? key.split("->>").map((part,index) => index ? "'" + part.replace(/'/g,"''") + "'" : qid(part)).join("->>") : qid(key);
        for (const [key, raw] of url.searchParams) {
          if (["select", "limit", "order", "offset", "on_conflict"].includes(key)) continue;
          if (key === "or" || key === "and") { filters.push(logical(raw,key.toUpperCase()));continue; }
          let operator = raw.slice(0, raw.indexOf(".")), value = raw.slice(raw.indexOf(".") + 1);
          if (operator === "eq") filters.push(`${column(key)} = ${bind(value === "false" ? false : value === "true" ? true : value)}`);
          else if (operator === "neq") filters.push(`${column(key)} <> ${bind(value === "false" ? false : value === "true" ? true : value)}`);
          else if (operator === "is") filters.push(`${qid(key)} IS ${value === "null" ? "NULL" : value === "true" ? "TRUE" : "FALSE"}`);
          else if (operator === "in") filters.push(`${qid(key)} = ANY(${bind(value.slice(1,-1).split(","))})`);
          else if (operator === "gt" || operator === "gte") filters.push(`${qid(key)} ${operator === "gt" ? ">" : ">="} ${bind(value)}`);
          else throw new Error(`unsupported_filter:${key}:${operator}`);
        }
        const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
        let query;
        if (req.method === "POST") {
          const keys = Object.keys(body);
          query = `INSERT INTO ${table} (${keys.map(qid).join(",")}) VALUES (${keys.map((key) => bind(typeof body[key] === "object" && body[key] !== null ? JSON.stringify(body[key]) : body[key])).join(",")}) RETURNING *`;
        } else if (req.method === "DELETE") query = `DELETE FROM ${table}${where} RETURNING *`;
        else if (req.method === "PATCH") query = `UPDATE ${table} SET ${Object.entries(body).map(([key,value]) => `${qid(key)}=${bind(typeof value === "object" && value !== null ? JSON.stringify(value) : value)}`).join(",")}${where} RETURNING *`;
        else {
          const selected = url.searchParams.get("select") ?? "*";
          const columns = selected === "*" ? "*" : selected.split(",").map(qid).join(",");
          const order = url.searchParams.get("order");
          query = `SELECT ${columns} FROM ${table}${where}`;
          if (order) query += ` ORDER BY ${order.split(",").map((part) => { const [col,dir] = part.split("."); return `${qid(col)} ${dir === "desc" ? "DESC" : "ASC"}`; }).join(",")}`;
          if (url.searchParams.has("limit")) query += ` LIMIT ${bind(Number(url.searchParams.get("limit")))}`;
        }
        const rows = (await db.query(query, params)).rows;
        if (req.headers.accept?.includes("object+json")) {
          if (rows.length !== 1) { res.writeHead(406, {"content-type":"application/json"}); res.end(JSON.stringify({code:"PGRST116",message:"JSON object requested, multiple (or no) rows returned",details:`The result contains ${rows.length} rows`})); return; }
          result = rows[0];
        } else result = rows;
      }
      const headers={"content-type":"application/json"};
      if(req.headers.prefer?.includes("count=exact")) headers["content-range"]=`0-${Math.max(0,(Array.isArray(result)?result.length:1)-1)}/${Array.isArray(result)?result.length:1}`;
      res.writeHead(200, headers); res.end(JSON.stringify(result));
    } catch (error) {
      faults.push({ route: url.pathname, message: error.message });
      res.writeHead(400, {"content-type":"application/json"}); res.end(JSON.stringify({code:"LOCAL_ADAPTER_ERROR",message:error.message}));
    }
  });
  await new Promise((resolve) => server.listen(0,"127.0.0.1",resolve));
  const dbURL = `http://127.0.0.1:${server.address().port}`;
  const port = 18763;
  const log = fs.openSync(process.env.C3_TEST_LOG ?? "/tmp/c3-actual-handler.log", "w");
  child = spawn(path.join(tools,"node_modules/.bin/deno"), ["run","--no-lock","--cached-only","--allow-env","--allow-net=127.0.0.1", ".github/scripts/c3_actual_handler_entry.ts"], {
    cwd: root, env: {PATH:process.env.PATH,DENO_DIR:process.env.DENO_DIR, SUPABASE_URL:dbURL,SUPABASE_SECRET_KEY:"local-synthetic-test-only",C3_TEST_HANDLER_PORT:String(port),KB_SINGAPORE_BASE_URL:dbURL,KB_SINGAPORE_TENANT_MAP_JSON:JSON.stringify({[company]:"34"}),KB_SINGAPORE_TENANT_API_KEYS_JSON:JSON.stringify({"34":"local-synthetic-key-only"})}, stdio:["ignore",log,log] });
  await new Promise((resolve,reject) => { const started = Date.now(); const poll = async () => { if (child.exitCode !== null) return reject(new Error("actual_handler_start_failed")); try { await fetch(`http://127.0.0.1:${port}`, {method:"OPTIONS"});resolve(); } catch { if (Date.now()-started>20000) reject(new Error("handler_start_timeout"));else setTimeout(poll,100); } };poll(); });
  const results = [];
  async function conversation(turns) {
    const id = randomUUID();
    await db.query("INSERT INTO conversations(id,company_id,status) VALUES($1,$2,'open')",[id,company]);
    const outputs=[];
    for(const content of turns) {
      const source=randomUUID();
      await db.query("INSERT INTO messages(id,conversation_id,role,content) VALUES($1,$2,'visitor',$3)",[source,id,content]);
      const semanticBefore=(await db.query("SELECT revision,state FROM conversation_commerce_state WHERE conversation_id=$1",[id])).rows;
      const memoryBefore=(await db.query("SELECT revision,memory FROM conversation_memory_state WHERE conversation_id=$1",[id])).rows;
      const before=(await db.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND role='assistant'",[id])).rows[0].n;
      const response=await fetch(`http://127.0.0.1:${port}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({conversation_id:id,source_message_id:source})});
      const outcome=await response.json();
      const rows=(await db.query("SELECT content,metadata FROM messages WHERE conversation_id=$1 AND role='assistant' ORDER BY created_at,id",[id])).rows;
      const semanticAfter=(await db.query("SELECT revision,state FROM conversation_commerce_state WHERE conversation_id=$1",[id])).rows;
      const memoryAfter=(await db.query("SELECT revision,memory FROM conversation_memory_state WHERE conversation_id=$1",[id])).rows;
      if(outcome.response_route === "c3_historical_conditional_calculation") {
        assert.deepEqual(semanticAfter,semanticBefore,"historical calculation mutated commerce");
        assert.deepEqual(memoryAfter,memoryBefore,"historical calculation mutated semantic memory");
      }
      let replay=null;
      if(outcome.handoff_persisted === true) {
        const counts=async()=> (await db.query("SELECT (SELECT count(*) FROM handoff_event WHERE conversation_id=$1)::int AS handoffs,(SELECT count(*) FROM messages WHERE conversation_id=$1 AND role='assistant')::int AS assistants",[id])).rows[0];
        const beforeReplay=await counts();
        const duplicate=await fetch(`http://127.0.0.1:${port}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({conversation_id:id,source_message_id:source})});
        const afterReplay=await counts();assert.deepEqual(afterReplay,beforeReplay,"R1 replay duplicated event/reply");
        replay={status:duplicate.status,outcome:await duplicate.json(),before:beforeReplay,after:afterReplay};
      }
      outputs.push({source,customer:content,status:response.status,outcome,replies:rows.slice(before),semanticAfter,memoryAfter,replay});
    }
    const state=(await db.query("SELECT status,assigned_agent_id FROM conversations WHERE id=$1",[id])).rows[0];
    const commerce=(await db.query("SELECT * FROM conversation_commerce_state WHERE conversation_id=$1",[id])).rows;
    const memory=(await db.query("SELECT * FROM conversation_memory_state WHERE conversation_id=$1",[id])).rows;
    const handoff=(await db.query("SELECT * FROM handoff_event WHERE conversation_id=$1",[id])).rows;
    const result={id,outputs,state,commerce,memory,handoff};results.push(result);
    fs.writeFileSync(process.env.C3_TEST_RESULT ?? "/tmp/c3-actual-handler-result.json",JSON.stringify({results,faults},null,2));
    return result;
  }
  for(const greeting of ["你好","你好，可以幫我嗎？","早晨，可唔可以幫我？","Hi","Hello, could you help me please?","Thanks","明白","OK"]) {
    const r=await conversation([greeting]);
    assert.equal(r.outputs[0].replies.length,1);
    assert.match(r.outputs[0].replies[0].content,/有咩可以幫|How can I help|welcome|anything else|有需要/i);
    assert.equal(r.commerce.length,0,"social turn created commerce state");
    assert.equal(r.memory.length,0,"social turn created business memory");
    assert.doesNotMatch(r.outputs[0].replies[0].content,/核實|範圍|日期|verifi/i);
  }
  for(const text of ["你好，我想查訂單","Hi, I need help choosing an AC"]) {
    const task=await conversation([text]);
    assert.notEqual(task.outputs[0].outcome.response_route,"natural_greeting");
    assert.equal(task.memory.length,1,"concrete task failed to establish business memory");
    assert.ok(task.memory[0].memory.current_goal);
    assert.doesNotMatch(task.outputs[0].replies[0].content,/How can I help|有咩可以幫/);
    if(text.includes("訂單")) assert.match(task.outputs[0].replies[0].content,/訂單或參考編號/);
    else assert.match(task.outputs[0].replies[0].content,/room.*area/i);
  }
  for(const [text,total] of [
    ["如果按舊價，每部 HK$4,750，三部再加 HK$960 送貨費，試算幾多？唔係現行報價。", "15,210"],
    ["假設兩部合共 HK$5,600，再加 HK$550 送貨，合共幾多？", "6,150"],
    ["Assuming HK$4,137 per unit plus HK$283 delivery per order, calculate for three units.", "12,694"],
  ]) {
    const r=await conversation([text]);
    console.log("CALC",text,r.outputs[0].replies.map(x=>x.content));
    assert.equal(r.outputs[0].replies.length,1);
    assert.ok(r.outputs[0].replies[0].content.includes(total));
    assert.doesNotMatch(r.outputs[0].replies[0].content,/鋁架|bracket/);
    assert.equal(r.commerce.length,0,"calculation created commerce state");
    assert.equal(r.memory.length,0,"calculation created semantic memory");
  }
  for(const text of ["之前機價 HK$6,247，送貨 HK$385。","之前四部合共 HK$9,312。"] ) {
    const r=await conversation([text]);
    assert.equal(r.outputs[0].replies.length,1);
    const reply=r.outputs[0].replies[0].content;
    assert.doesNotMatch(reply,/鋁架|安裝同|每部.{0,12}9,312/);
    if(text.includes("送貨")) assert.match(reply,/送貨.{0,12}385/);
    else assert.match(reply,/9,312/);
  }
  const money=await conversation(["之前機價 HK$6,247，送貨 HK$385。","用返頭先個送貨費，加兩部每部 HK$4,111，合共幾多？"]);
  assert.match(money.outputs[1].replies[0].content,/8,607/);
  const historical=money.memory[0].memory.historical_facts;
  assert.ok(historical.some(f=>f.value.amount===6247&&f.value.semantic_role==="unit_price"));
  assert.ok(historical.some(f=>f.value.amount===385&&f.value.semantic_role==="delivery"&&f.source_message_id===money.outputs[0].source));
  assert.ok(historical.every(f=>f.value.reusable_as_current===false));
  for(const [text,total] of [["假設每部 HK$1,399.95，三部加整單 HK$0 送貨，試算幾多？","4,199.85"],["假設兩部合共 HK$5,617.25，再加整單 HK$18.50，合共幾多？","5,635.75"]]) {
    const decimal=await conversation([text]);assert.match(decimal.outputs[0].replies[0].content,new RegExp(total.replace(/\./g,"\\.")));
    assert.doesNotMatch(decimal.outputs[0].replies[0].content,/0 \+/);
  }
  const unspecified=await conversation(["假設機價 HK$8,123，幫我試算三部幾多？"]);
  assert.match(unspecified.outputs[0].replies[0].content,/單價|總額/);
  function governed(c,turn) {
    assert.equal(c.handoff.length,1);assert.equal(c.handoff[0].source_message_id,c.outputs[turn].source);
    assert.equal(c.outputs.at(-1).replies.length,0);assert.equal(c.outputs.at(-1).outcome.skipped,"human_handling");
    const p=JSON.parse(c.handoff[0].ai_summary).structured_package;
    assert.equal(p.generated_from_source_message_id,c.outputs[turn].source);
    assert.equal(p.conversation_memory_lineage.source_message_id,c.outputs[turn].source);
    assert.ok(p.current_authoritative_kb_facts.length);assert.ok(p.citations.length);
    assert.ok(p.latest_corrections.length);assert.ok(p.handoff_reason);
    assert.ok(p.current_customer_facts.length);assert.ok(p.current_customer_goal);
    assert.equal(p.conversation_memory_lineage.commerce_state_revision,p.commerce_state_revision);
    assert.ok(c.outputs[turn].replay,"actual R1 replay not exercised");
    for (const fact of p.current_authoritative_kb_facts) {
      assert.ok(c.outputs.some(row=>row.source===fact.source_message_id && row.replies.some(reply=>reply.metadata.citation_lineage?.authority_decision==="USE_CURRENT_KB")));
      assert.ok(p.citations.some(citation=>citation.document_id===fact.document_id&&citation.chunk_id===fact.chunk_id));
    }
    assert.equal(c.commerce[0].state.conversion.order_status,"none");
    assert.equal(c.commerce[0].state.conversion.payment_status,"none");
    return p;
  }
  const saas=await conversation([
    "I need 7 seats of CN-314 subscription.","I need 1 NX-529 add-on.",
    "Change CN-314 subscription to 9 seats.","What is the CN-314 billing policy? Please answer in English.",
    "Defer NX-529 add-on. Back to CN-314 subscription.","Thanks",
    "用廣東話兩句總結我而家嘅要求。","我想真人客服接手。","還有一個問題。"]);
  console.log("SAAS",saas.outputs.map(t=>[t.customer,t.replies.map(x=>x.content)]));
  const sp=governed(saas,7);
  assert.ok(sp.active_entities.some(e=>e.category==="subscription"&&e.quantity===9));
  assert.ok(sp.deferred_entities.some(e=>e.category==="addon"&&e.quantity===1));
  assert.match(saas.outputs[3].replies[0].content,/monthly/);
  assert.equal(saas.outputs[3].outcome.response_route,"canonical_kb_direct_answer");
  assert.match(saas.outputs[6].replies[0].content,/9/);
  assert.deepEqual(saas.outputs[5].semanticAfter,saas.outputs[4].semanticAfter,"social acknowledgement changed commerce");
  assert.deepEqual(saas.outputs[5].memoryAfter,saas.outputs[4].memoryAfter,"social acknowledgement changed memory");
  assert.ok(!sp.open_questions.some(q=>/billing|recap|summary|總結|Thanks/i.test(q)));
  const booking=await conversation([
    "I need 2 sessions of BK-827 booking on 2026-11-04.","I need 1 PK-692 parking.",
    "Defer PK-692 parking. Change BK-827 booking to 3 sessions.",
    "Change BK-827 booking date to 2026-11-06.","What is the BK-827 booking policy?",
    "用廣東話兩句總結我而家嘅要求。","我想轉真人接手。","接手後再問一句。"]);
  console.log("BOOKING",booking.outputs.map(t=>[t.customer,t.replies.map(x=>x.content)]));
  const bp=governed(booking,6);
  assert.match(booking.outputs[3].replies[0].content,/2026-11-06/);
  assert.doesNotMatch(booking.outputs[3].replies[0].content,/Which date|邊.*日期/);
  assert.ok(bp.active_entities.some(e=>e.category==="booking"&&e.quantity===3&&e.attributes.requested_date==="2026-11-06"));
  assert.ok(bp.deferred_entities.some(e=>e.category==="parking"&&e.quantity===1));
  assert.equal(booking.outputs[4].outcome.response_route,"canonical_kb_direct_answer");
  assert.equal(booking.commerce[0].state.delivery.confirmed,false);
  const scoped=booking.outputs[2].semanticAfter[0];
  assert.equal(scoped.revision,booking.outputs[1].semanticAfter[0].revision+1,"compound mutation not one atomic revision");
  assert.equal(scoped.state.entities.find(e=>e.category==="booking").quantity,3);
  assert.equal(scoped.state.entities.find(e=>e.category==="parking").status,"deferred");
  assert.ok(bp.pending_actions.some(q=>/staff confirmation/i.test(q)));
  assert.ok(!bp.open_questions.some(q=>/policy|recap|summary|總結/i.test(q)));
  const dialogue=await conversation([
    "早晨，我間書房大約95呎，想揀部窗口冷氣。見到 CW-SUL70BA，呢款係幾多匹，同埋有咩主要功能？",
    "咁嗰部擺喺95呎書房夠唔夠？個窗下午幾曬。",
    "另外想睇雪櫃，廚房最多610mm闊，雙門款有冇方向？",
    "雪櫃先擺低啦。講返書房嗰部，我量錯，書房其實105呎；咁要點評估佢夠唔夠？",
    "就係 CW-SUL70BA，書房改咗105呎；please explain briefly in English how I should assess it.",
    "可唔可以用廣東話兩句講返我而家嘅冷氣同雪櫃要求？",
    "純粹假設每部 HK$4,263，三部再加 HK$417 送貨，試算幾多？唔係現行報價。",
    "朋友話 MOONCOOL-XYZ77 有自動清洗，你有可靠資料確認嗎？",
    "我想轉真人客服接手，冷氣继续，雪櫃暫緩，唔好再問型號。",
    "接手之後我仲有一個問題。",
  ]);
  for(const row of dialogue.outputs) console.log("DIALOGUE",row.customer,row.replies.map(x=>x.content));
  assert.ok(dialogue.outputs[0].replies[0].content.includes("3/4"),"known KB answer missing");
  assert.ok(dialogue.outputs[3].replies[0].content.includes("105"),"corrected area not acknowledged");
  assert.doesNotMatch(dialogue.outputs[4].replies[0].content,/[\u3400-\u9fff]/,"English instruction lost");
  assert.match(dialogue.outputs[5].replies[0].content,/105/);
  assert.equal(dialogue.handoff.length,1);
  assert.equal(dialogue.handoff[0].source_message_id,dialogue.outputs[8].source);
  assert.equal(dialogue.outputs[9].replies.length,0);
  const pack=JSON.parse(dialogue.handoff[0].ai_summary).structured_package;
  assert.ok(pack.active_entities.length,"structured active entities empty");
  assert.ok(pack.latest_corrections.length,"structured corrections empty");
  assert.ok(pack.current_authoritative_kb_facts.length,"structured KB facts empty");
  assert.ok(pack.citations.length,"structured citations empty");
  assert.ok(pack.open_questions.every(q=>!/試算|recap|總結|MOONCOOL|幾多匹|historical/i.test(q)),"completed questions retained as open");
  assert.ok(pack.open_questions.every(q=>!/高度|深度|refrigerator/i.test(q)),"deferred entity question remains active");
  assert.ok(pack.pending_actions.some(q=>/site|professional/i.test(q)),"site assessment lost");
  assert.equal(pack.generated_from_source_message_id,dialogue.outputs[8].source);
  assert.equal(pack.conversation_memory_lineage.source_message_id,dialogue.outputs[8].source);
  assert.equal(pack.conversation_memory_lineage.commerce_state_revision,pack.commerce_state_revision);
  const ac=pack.active_entities.find(entity=>entity.category==="air_conditioner");
  assert.equal(ac.model,"CW-SUL70BA");
  assert.equal(ac.attributes.room_sizes.study,"105平方呎");
  assert.equal(ac.attributes.sunlight,"strong_afternoon_sun");
  assert.equal(ac.attributes.installation_type,"window_unit");
  const fridge=pack.deferred_entities.find(entity=>entity.category==="refrigerator");
  assert.equal(fridge.constraints.max_width_mm,610);
  assert.equal(fridge.attributes.door_count,2);
  assert.ok(pack.latest_corrections.some(c=>c.includes("95")&&c.includes("105")));
  assert.ok(pack.current_authoritative_kb_facts.some(f=>f.field==="horsepower"&&f.value==="3/4匹"));
  for(const fact of pack.current_authoritative_kb_facts) {
    const source=dialogue.outputs.find(turn=>turn.source===fact.source_message_id);
    assert.ok(source?.replies.some(reply=>reply.metadata.control_commit==="ai"&&reply.metadata.citation_lineage?.authority_decision==="USE_CURRENT_KB"));
    assert.ok(pack.citations.some(c=>c.document_id===fact.document_id&&c.chunk_id===fact.chunk_id));
    assert.equal(fact.model,"CW-SUL70BA");
  }
  const varied = await conversation([
    "你好，書房大約117呎，想睇窗口冷氣 ZZ-KL88，佢有咩功能同幾多匹？",
    "另外想睇雪櫃，擺位最多587mm闊，三門款有冇建議？",
    "雪櫃先擺低。講返書房嗰部，我量錯，書房其實123呎，咁要點評估佢夠唔夠？",
    "就係 ZZ-KL88，please assess it briefly in English for the corrected 123 sq ft study.",
    "用廣東話兩句總結我而家冷氣同雪櫃要求。",
    "我想真人接手，雪櫃暫緩，冷氣繼續。",
    "接手後再問一句。",
  ]);
  assert.match(varied.outputs[0].replies[0].content,/ZZ-KL88/);
  assert.doesNotMatch(varied.outputs[1].replies[0].content.split(/[。.!]/).at(-1),/闊|width/);
  assert.match(varied.outputs[2].replies[0].content,/123/);
  assert.doesNotMatch(varied.outputs[3].replies[0].content,/[\u3400-\u9fff]/);
  assert.match(varied.outputs[4].replies[0].content,/123/);
  assert.match(varied.outputs[4].replies[0].content,/587/);
  assert.match(varied.outputs[4].replies[0].content,/3門/);
  assert.equal(varied.handoff.length,1);
  assert.equal(varied.handoff[0].source_message_id,varied.outputs[5].source);
  assert.equal(varied.outputs[6].replies.length,0);
  const variedPack=JSON.parse(varied.handoff[0].ai_summary).structured_package;
  assert.ok(variedPack.latest_corrections.some(c=>c.includes("117")&&c.includes("123")),"varied correction lost from structured package");
  assert.equal(variedPack.generated_from_source_message_id,varied.outputs[5].source);
  assert.equal(variedPack.active_entities.find(e=>e.category==="air_conditioner").attributes.room_sizes.study,"123平方呎");
  const r=await conversation(["你好，可以幫我嗎？","我想真人客服接手，唔好再問需求。","我仲有一個問題。"]);
  assert.equal(r.handoff.length,1);
  assert.equal(r.handoff[0].source_message_id,r.outputs[1].source);
  assert.equal(r.state.status,"pending");
  assert.equal(r.outputs[2].replies.length,0);
  assert.equal(r.outputs[2].outcome.skipped,"human_handling");
  assert.ok(JSON.parse(r.handoff[0].ai_summary).structured_package);
  for (const conversation of results) for (const turn of conversation.outputs) {
    assert.equal(turn.status,200);
    assert.equal(turn.outcome.success,true);
    assert.notEqual(turn.outcome.degraded,true,`degraded reply: ${turn.customer}`);
    assert.notEqual(turn.outcome.response_route,"terminal_failure_recovery");
    assert.ok(turn.replies.every((reply) => !reply.content.includes("__THINKING__")));
    assert.ok(turn.replies.length <= 1,"duplicate customer-visible reply");
    for (const reply of turn.replies) if (reply.metadata.control_commit === "ai") assert.equal(reply.metadata.source_message_id,turn.source);
  }
  assert.equal(faults.length,0,JSON.stringify(faults));
  await db.exec(read("supabase/migrations/rollback/20260930090000_c3_handoff_grounded_facts.rollback.sql"));
  assert.deepEqual(await catalog(),acceptedHandoff,"rollback changed the accepted function/security identity");
  assert.deepEqual(await triggers(),acceptedTriggers);assert.deepEqual(await ledger(),acceptedLedger);
  fs.writeFileSync(process.env.C3_TEST_RESULT ?? "/tmp/c3-actual-handler-result.json",JSON.stringify({coverage:"actual_handler_local_sql_integration",limitations:["local transport adapter, not hosted PostgREST/Widget","pgcrypto digest backed by PostgreSQL built-in sha256","synthetic tenant, no production traffic"],results,faults,forwardCatalog,rollbackCatalog:await catalog(),triggerBindings:await triggers(),migrationLedger:await ledger(),assertions:{social_state_hygiene:true,question_lifecycle:true,typed_money_persistence_and_recall:true,generic_saas:true,generic_booking:true,real_r1_sql_package_and_suppression:true,r1_replay_idempotent:true,b2_source_binding:true,no_duplicate_reply:true,no_thinking:true,no_terminal_failure:true,no_transaction_promotion:true,migration_forward:true,migration_rollback:true,catalog_owner_security_search_path_acl:true,commit_ai_reply_tx_unchanged:true,trigger_binding_preserved:true,migration_ledger_preserved:true}},null,2));
  console.log(`actual_handler_local_sql_integration PASS: ${results.length} conversations; first R1 real SQL event/source binding/package; next-turn suppression`);
} catch(error) { console.error(error.message,JSON.stringify(faults));process.exitCode=1; }
finally { child?.kill(); if(server) await new Promise((resolve)=>server.close(resolve));await db.close(); }
