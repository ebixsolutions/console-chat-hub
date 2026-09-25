import { arbitrateAnaphoricProductFollowUp } from "./natural-customer-response.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const scope = { conversation_id: "conversation", company_id: "company" };
const row = (content: string, extra: Record<string, string> = {}) => ({
  role: "visitor",
  content,
  ...scope,
  ...extra,
});

Deno.test("W17 A restores the one active AC referent after refrigerator switch", () => {
  const result = arbitrateAnaphoricProductFollowUp(
    "講返頭先嗰部冷氣，細房研究緊邊個型號同幾多匹？",
    [row("另外雪櫃都想換，擺位闊度最多595mm。"), row("細房研究緊 CW-SUL70BA，佢係幾多匹？")],
    scope,
  );
  assert(result.kind === "resolved" && result.intent.product === "CW-SUL70BA" && result.resolved_topic === "air_conditioner" && result.resolution_strategy === "PER_TOPIC_REFERENT_HISTORY", JSON.stringify(result));
});

Deno.test("W17 B restores refrigerator history without AC contamination", () => {
  const result = arbitrateAnaphoricProductFollowUp("講返頭先嗰部雪櫃，佢有咩功能？", [row("CW-SUL70BA 冷氣係3/4匹。"), row("雪櫃 RF-AB12345 有咩功能？")], scope);
  assert(result.kind === "resolved" && result.intent.product === "RF-AB12345" && result.resolved_topic === "refrigerator", JSON.stringify(result));
});

Deno.test("W17 C a second active AC product remains ambiguous", () => {
  const result = arbitrateAnaphoricProductFollowUp("講返頭先部冷氣，佢幾多匹？", [row("另一部冷氣 CS-XY12345 都考慮緊。"), row("CW-SUL70BA 冷氣係3/4匹。")], scope);
  assert(result.kind === "clarification" && result.intent.candidates.length === 2, JSON.stringify(result));
});

Deno.test("W17 D cancelled AC referent is not revived after switching away", () => {
  const result = arbitrateAnaphoricProductFollowUp("講返頭先部冷氣，佢幾多匹？", [row("CW-SUL70BA 冷氣取消，唔再考慮。"), row("轉睇雪櫃。"), row("CW-SUL70BA 冷氣係3/4匹。")], scope);
  assert(result.kind === "clarification", JSON.stringify(result));
});

Deno.test("W17 E two active same-category products require clarification", () => {
  const result = arbitrateAnaphoricProductFollowUp("the AC we were discussing, how much is it?", [row("AC model CS-XY12345 is another option."), row("AC model CW-SUL70BA is one option.")], scope);
  assert(result.kind === "clarification" && result.intent.candidates.length === 2, JSON.stringify(result));
});

Deno.test("W17 F same-topic T7 still resolves the immediate product", () => {
  const result = arbitrateAnaphoricProductFollowUp("咁呢部而家賣幾錢？", [row("細房我見到 CW-SUL70BA，佢有咩功能、係幾多匹？")], scope);
  assert(result.kind === "resolved" && result.intent.product === "CW-SUL70BA" && result.intent.fact === "price", JSON.stringify(result));
});

Deno.test("W17 G quantity and order recall remain outside product arbitration", () => {
  for (const text of ["我而家要幾多部？", "三部係咪落咗單？"]) {
    const result = arbitrateAnaphoricProductFollowUp(text, [row("CW-SUL70BA 冷氣係3/4匹。")], scope);
    assert(result.kind === "not_applicable", `${text}:${JSON.stringify(result)}`);
  }
});

Deno.test("W17 tenant or conversation scope mismatch fails closed", () => {
  const result = arbitrateAnaphoricProductFollowUp("講返頭先部冷氣，佢幾多匹？", [row("CW-SUL70BA 冷氣係3/4匹。", { company_id: "other" })], scope);
  assert(result.kind === "clarification", JSON.stringify(result));
});
