import { corsHeaders, json } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  return json({
    ok: true,
    source: "health-check",
    timestamp: new Date().toISOString(),
  });
});
