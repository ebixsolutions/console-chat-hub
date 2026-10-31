import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const widget = readFileSync("public/widget/chat.js", "utf8");
const endpoint = readFileSync("supabase/functions/widget-poll-messages/index.ts", "utf8");
const detail = readFileSync("src/routes/_authenticated/console.conversations.$id.tsx", "utf8");

test("Task1C: public Widget does not periodically query message history", () => {
  assert.doesNotMatch(widget, /POLL_STEPS|pollStep|pollTimer|schedulePoll|setInterval\s*\(/);
  assert.match(widget, /subscribe_events:true/);
  assert.match(widget, /response\.body\.getReader\(\)/);
  assert.match(widget, /ready\|invalidate\|close/);
  assert.match(widget, /if \(catchUpPending && pollActive && !document\.hidden\)/);
  assert.match(widget, /seenIds\[message\.id\]/);
  assert.match(widget, /if \(consolePreview\) executePoll\(\)/);
});
test("Task1C: stream never exposes messages or authorization across tenants", () => {
  assert.match(endpoint, /if \(subscribe_events === true\)/);
  assert.match(endpoint, /conv\.visitor_session_id !== session\.id/);
  assert.match(endpoint, /conv\.channel_config_id !== channel\.id/);
  assert.match(endpoint, /conv\.company_id !== channel\.company_id/);
  assert.match(endpoint, /validateWidgetOrigin\(req, channel\.allowed_origins\)/);
  assert.match(endpoint, /originalPreviewRequest\(req,createClient,supabase,conv,false\)/);
  assert.match(endpoint, /notify\("invalidate"\)/);
  assert.match(endpoint, /const verifiedNotify = async/);
  assert.match(endpoint, /current\.visitor_session_id !== liveSession\.id/);
  assert.doesNotMatch(endpoint, /lifetime = setTimeout|setTimeout\(\(\) => \{ notify\("close"\)/);
  assert.match(endpoint, /supabase\.removeChannel\(eventChannel\)/);
  assert.match(endpoint, /clearInterval\(heartbeat\)/);
  assert.match(endpoint, /"Cache-Control": "no-store, no-transform"/);
  assert.doesNotMatch(endpoint, /notify\((?:message|content|session_token)\)/);
});
test("Task1C: detail Inbox keeps scoped realtime wiring for initial and reconnect catch-up", () => {
  assert.doesNotMatch(detail, /setInterval\s*\(|fallbackTimerRef|startDetailFallback/);
  // Initial/reconnect acknowledgement coalescing and stale/removed callbacks are
  // exercised by the existing Task3 detail tests in ticket-detail-readback.test.mjs.
  // The required c3-preproduction job runs that renderer suite; this offline group
  // retains the event-only, scoped subscription and cleanup source checks below.
  assert.match(detail, /"postgres_changes"/);
  assert.match(detail, /conversation_id=eq/);
  assert.match(detail, /subscribe\(handleDetailSubscribeStatus\)/);
  assert.match(detail, /removeChannel\(msgChannel\)/);
});

import './widget-event-runtime.test.mjs';
