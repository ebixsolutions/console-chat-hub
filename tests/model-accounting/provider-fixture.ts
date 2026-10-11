/** Mock-only accounting/REST boundary for existing isolated provider safety tests. */
export function withMockAccounting(provider: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://accounting.mock/rest/v1/")) {
      if (url.includes("/rpc/c3_reserve_model_attempt")) {
        return Response.json({
          scoped: true,
          dispatch: true,
          run_id: "mock-run",
          state: "reserved",
        });
      }
      if (url.includes("/rpc/c3_finalize_model_attempt")) {
        return Response.json({ state: JSON.parse(String(init?.body)).p_state });
      }
      if (url.includes("upstream_call_log")) {
        return new Response(null, { status: 201 });
      }
      if (
        url.includes("conversation_memory_state") ||
        url.includes("conversation_commerce_state")
      ) return Response.json([]);
      throw Error("unexpected mock accounting request");
    }
    if (url !== "https://api.anthropic.com/v1/messages") {
      throw Error("unexpected network target");
    }
    return await provider(input, init);
  };
}
