// Test transport only: use the exact registered production request callback.
const serve = Deno.serve;
let callback: Deno.ServeHandler | undefined;
Deno.serve = ((handler: Deno.ServeHandler) => {
  callback = handler;
  return {};
}) as typeof Deno.serve;
await import("../../supabase/functions/generate-reply/index.ts");
Deno.serve = serve;
if (!callback) throw new Error("production_handler_not_registered");
serve({ hostname: "127.0.0.1", port: Number(Deno.env.get("C3_TEST_HANDLER_PORT")) }, callback);
