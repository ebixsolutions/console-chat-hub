import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isDirectViolentThreat } from "../../supabase/functions/_shared/e2-direct-threat.ts";

Deno.test("E2 direct violent threat positives", () => {
  const positives = [
    "我要殺了你。",
    "我会杀了你",
    "我將傷害他們",
    "I will kill you",
    "I'm going to hurt them",
    "I'll attack someone",
  ];
  for (const value of positives) assertEquals(isDirectViolentThreat(value), true, value);
});

Deno.test("E2 direct violent threat false-positive guardrails", () => {
  const negatives = [
    "這部機有殺菌功能嗎？",
    "可以幫我殺價嗎？",
    "我想殺時間",
    "I want to kill time",
    "This cleaner kills bacteria",
    "我很生氣，但不要轉真人。",
  ];
  for (const value of negatives) assertEquals(isDirectViolentThreat(value), false, value);
});
