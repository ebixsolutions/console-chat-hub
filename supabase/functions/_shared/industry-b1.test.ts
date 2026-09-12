import { createIndustryRegistry } from "./industry-agent-registry.ts";
import { resolveIndustryProfile, resolveIndustryRuntime } from "./industry-runtime-adapter.ts";
import { validateIndustrySchema, validateIndustrySchemaValues } from "./industry-schema.ts";
import { HOME_APPLIANCE_PROFILE_V1 } from "./industry-profiles/home-appliance-v1.ts";
import { runCommerceStateRuntime, type CommerceStateDbClient } from "./commerce-state-runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("B1 registry resolves canonical and aliased industry identifiers", () => {
  assert(
    resolveIndustryProfile("home_appliance") === HOME_APPLIANCE_PROFILE_V1,
    "canonical id did not resolve",
  );
  assert(
    resolveIndustryProfile("Home Appliances") === HOME_APPLIANCE_PROFILE_V1,
    "normalized alias did not resolve",
  );
  assert(resolveIndustryProfile("unknown_industry") === null, "unknown industry must fail closed");
});

Deno.test("B1 registry rejects an invalid schema binding", () => {
  let rejected = false;
  try {
    createIndustryRegistry([{ ...HOME_APPLIANCE_PROFILE_V1, id: "different_industry" }]);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("industry_schema_binding_mismatch");
  }
  assert(rejected, "mismatched profile/schema ids must be rejected");
});

Deno.test(
  "B1 schema validation accepts declared values and rejects unknown or invalid values",
  () => {
    assert(
      validateIndustrySchema(HOME_APPLIANCE_PROFILE_V1.schema).valid,
      "reference schema should be valid",
    );
    assert(
      validateIndustrySchemaValues(HOME_APPLIANCE_PROFILE_V1.schema, {
        product: "air conditioner",
        model: "AC-100",
        capacity: "2.5 kW",
        installation: { required: true },
        delivery: { requested: true },
        engineering: { site_check: true },
        payment: { status: "pending_quote" },
        warranty: "customer requests five years",
      }).valid,
      "valid values should pass",
    );
    assert(
      !validateIndustrySchemaValues(HOME_APPLIANCE_PROFILE_V1.schema, { capacity: 2.5 }).valid,
      "wrong field type must fail",
    );
    assert(
      !validateIndustrySchemaValues(HOME_APPLIANCE_PROFILE_V1.schema, { invented: true }).valid,
      "unknown field must fail",
    );
  },
);

Deno.test("Home Appliance Profile v1 exposes every contracted B1 field", () => {
  const keys = new Set(HOME_APPLIANCE_PROFILE_V1.schema.fields.map((field) => field.key));
  for (const required of [
    "product",
    "model",
    "capacity",
    "installation",
    "delivery",
    "engineering",
    "payment",
    "warranty",
  ]) {
    assert(keys.has(required), `missing Home Appliance field: ${required}`);
  }
});

Deno.test("B1 runtime adapter routes appliances without creating unsupported entities", () => {
  const appliance = resolveIndustryRuntime({ texts: ["我要一部客廳冷氣"] });
  assert(appliance.industry_id === "home_appliance", "appliance industry was not detected");
  assert(appliance.hints.length === 1, "expected one scoped appliance hint");
  assert(
    appliance.hints[0].entity_id === "air_conditioner:living_room",
    "legacy entity identity changed",
  );

  const unrelated = resolveIndustryRuntime({ texts: ["I need two consulting sessions"] });
  assert(unrelated.industry_id === null, "generic commerce must not be forced into an industry");
  assert(unrelated.hints.length === 0, "unknown industry must not create profile entities");

  const unsupported = resolveIndustryRuntime({
    texts: ["I need an air conditioner"],
    industry_identifier: "unsupported_industry",
  });
  assert(unsupported.industry_id === null, "an explicit unknown identifier must fail closed");
});

Deno.test("B1 integrates through the guarded A3 persistence path", async () => {
  let rpcName = "";
  let rpcParams: Record<string, unknown> = {};
  const db: CommerceStateDbClient = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
    rpc: async (name, params) => {
      rpcName = name;
      rpcParams = params;
      return { data: { result: "success", applied_revision: 1 }, error: null };
    },
  };

  const result = await runCommerceStateRuntime(db, {
    conversation_id: "conversation-b1",
    company_id: "tenant-b1",
    source_message_id: "message-b1",
    text: "我要一部客廳冷氣",
    language: "zh-TW",
  });

  assert(result?.revision === 1, "runtime did not use the existing persistence result");
  assert(rpcName === "upsert_conversation_commerce_state_v1", "guarded persistence RPC changed");
  assert(rpcParams.p_company_id === "tenant-b1", "tenant id was not preserved");
  const state = rpcParams.p_state as {
    current_industry?: unknown;
    entities?: Array<{ entity_id?: unknown }>;
  };
  assert(
    state.current_industry === "home_appliance",
    "resolved industry was not written through the reducer",
  );
  assert(
    state.entities?.[0]?.entity_id === "air_conditioner:living_room",
    "profile entity was not reduced canonically",
  );
});
