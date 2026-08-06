/**
 * Controlled LLM stub server for CE Edge Function contract tests.
 * Configurable via POST /__config to return specific response behaviors.
 * 
 * Usage: deno run --allow-net tests/stubs/llm-stub-server.ts
 * Default port: 9999 (override with PORT env)
 */

const PORT = parseInt(Deno.env.get("PORT") || "9999");

type StubMode =
  | "reset"
  | "timeout"
  | "http_500"
  | "non_json"
  | "malformed_json"
  | "missing_evaluator"
  | "extra_evaluator"
  | "nonnumeric_score"
  | "out_of_range"
  | "provenance_mismatch"
  | "valid_six";

let currentMode: StubMode = "reset";

const VALID_SIX_RESPONSE = {
  evaluations: {
    accuracy: { score: 75, reasoning: "Test accuracy" },
    policy: { score: 80, reasoning: "Test policy" },
    tone: { score: 85, reasoning: "Test tone" },
    sales: { score: 50, reasoning: "Test sales" },
    context: { score: 70, reasoning: "Test context" },
    hallucination_risk: { score: 20, reasoning: "Test hallucination" },
  },
};

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);

  // Config endpoint
  if (url.pathname === "/__config") {
    if (req.method === "POST") {
      const body = await req.text();
      const mode = JSON.parse(body) as StubMode;
      currentMode = mode;
      return new Response(JSON.stringify({ mode: currentMode }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (req.method === "GET") {
      return new Response(JSON.stringify({ mode: currentMode }), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // LLM endpoint - respond based on current mode
  switch (currentMode) {
    case "timeout":
      await new Promise((r) => setTimeout(r, 120_000)); // 2 min delay
      return new Response("timeout", { status: 504 });

    case "http_500":
      return new Response("Internal Server Error", { status: 500 });

    case "non_json":
      return new Response("This is not JSON at all", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });

    case "malformed_json":
      return new Response('{"evaluations": {"broken', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    case "missing_evaluator":
      return new Response(
        JSON.stringify({
          evaluations: {
            accuracy: { score: 75 },
            policy: { score: 80 },
            // missing tone, sales, context, hallucination_risk
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    case "extra_evaluator":
      return new Response(
        JSON.stringify({
          evaluations: {
            ...VALID_SIX_RESPONSE.evaluations,
            unknown_dimension: { score: 50 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    case "nonnumeric_score":
      return new Response(
        JSON.stringify({
          evaluations: {
            accuracy: { score: "high" },
            policy: { score: 80 },
            tone: { score: 85 },
            sales: { score: 50 },
            context: { score: 70 },
            hallucination_risk: { score: 20 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    case "out_of_range":
      return new Response(
        JSON.stringify({
          evaluations: {
            accuracy: { score: 150 },
            policy: { score: -10 },
            tone: { score: 85 },
            sales: { score: 50 },
            context: { score: 70 },
            hallucination_risk: { score: 20 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    case "provenance_mismatch":
      return new Response(
        JSON.stringify({
          evaluations: VALID_SIX_RESPONSE.evaluations,
          model: "wrong-model-version",
          prompt: "wrong-prompt-version",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    case "valid_six":
      return new Response(JSON.stringify(VALID_SIX_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    default: // reset
      return new Response(JSON.stringify({ error: "stub not configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
  }
});
