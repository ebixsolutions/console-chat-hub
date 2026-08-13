// supabase/functions/kb-adapter/index.ts
// PR-KB — retired legacy adapter fail-closed boundary.
//
// The old adapter accepted browser/server supplied workspace_id + tenant_id and
// called the pre-Singapore KB request contract. That is incompatible with the
// authoritative Singapore backend, where tenant scope comes ONLY from the
// validated Bearer JWT identity. Canonical production callers now use
// _shared/kb-client.ts directly.

function jsonNoCors(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonNoCors(
      {
        error: {
          error_code: "INVALID_INPUT",
          message_safe: "Method not allowed",
          retryable: false,
        },
      },
      405,
    );
  }

  const internalToken = Deno.env.get("KB_INTERNAL_SERVICE_TOKEN");
  const presented =
    req.headers.get("X-Internal-Service-Token") ??
    req.headers.get("x-internal-service-token");

  if (!internalToken || !presented || presented !== internalToken) {
    return jsonNoCors(
      {
        error: {
          error_code: "UNAUTHORIZED",
          message_safe: "Unauthorized.",
          retryable: false,
        },
      },
      401,
    );
  }

  // Fail closed rather than accepting caller-controlled tenant/workspace scope
  // or sending the retired request schema upstream.
  return jsonNoCors(
    {
      error: {
        error_code: "KB_ADAPTER_RETIRED",
        message_safe:
          "Legacy KB adapter retired. Use canonical Singapore KB integration.",
        retryable: false,
      },
      handoff_required: true,
      no_answer: true,
    },
    410,
  );
});
