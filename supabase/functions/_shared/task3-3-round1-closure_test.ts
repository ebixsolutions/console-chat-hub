/**
 * Task 3.3 Round 1 conversational closure regression tests.
 *
 * Machine-checkable behaviour for the canonical conversational modules:
 * R1 false-positive suppression, answerability gating, customer-facing
 * language policy, continuity signals, human-control parity and
 * underspecified-intent clarification.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyHandoffIntent, isExplicitHandoffRequest, isPureHandoffNegation } from "./handoff-intent.ts";
import { assessAnswerability } from "./answerability.ts";
import {
  containsInternalTerminology,
  sanitizeCustomerFacingText,
} from "./customer-response-policy.ts";
import { deriveContinuitySignals } from "./conversation-continuity.ts";
import { assessHumanControl } from "./human-control.ts";
import { classifyConversationalRoute, isUnderspecifiedIntent } from "./conversational-routing.ts";

Deno.test("R1: explicit human requests are detected", () => {
  for (const text of [
    "I want to talk to a human agent",
    "transfer me to an agent please",
    "請轉真人客服",
    "我要找真人",
  ]) {
    assert(isExplicitHandoffRequest(text), `expected explicit request: ${text}`);
  }
});

Deno.test("R1: negation / conditional / informational mentions never escalate", () => {
  for (const text of [
    "Don't transfer me to a human, just answer here",
    "I do not want to talk to an agent",
    "不要轉真人客服，你直接回答我就好",
    "Maybe later I might need an agent",
    "如果之後需要，我再找真人",
    "Do you have human agents available?",
    "你們有真人客服嗎？",
  ]) {
    const c = classifyHandoffIntent(text);
    assertEquals(c.explicit_request, false, `must not escalate: ${text}`);
  }
});

Deno.test("R1: pure negation is reported for auditing", () => {
  assert(isPureHandoffNegation("don't transfer me to a human"));
  assert(!isPureHandoffNegation("transfer me to a human"));
});

Deno.test("Answerability: retrieval score alone cannot authorise an answer", () => {
  const result = assessAnswerability({
    question: "How much is the refund fee for damaged items?",
    evidence: [{
      score: 0.93,
      content:
        "Store opening hours are 9am to 6pm on weekdays and 10am to 5pm on weekends at all retail branches.",
    }],
  });
  assertEquals(result.answerable, false);
  assertEquals(result.reason, "topic_not_covered");
});

Deno.test("Answerability: covering confirmed content is answerable", () => {
  const result = assessAnswerability({
    question: "What is the refund window for damaged items?",
    evidence: [{
      score: 0.81,
      content:
        "Refund policy: damaged items can be refunded within 30 days of delivery. Send photos of the damage and the order number to start the refund.",
    }],
  });
  assertEquals(result.answerable, true);
  assertEquals(result.reason, "answerable_from_confirmed_content");
});

Deno.test("Answerability: no evidence is never answerable", () => {
  const result = assessAnswerability({ question: "any question", evidence: [] });
  assertEquals(result.answerable, false);
  assertEquals(result.reason, "no_confirmed_content");
});

Deno.test("Customer policy: internal terminology is detected and removed", () => {
  const leaky = "Based on the knowledge base retrieval score 0.42, the RAG context has no matching chunk.";
  assert(containsInternalTerminology(leaky));
  const clean = sanitizeCustomerFacingText(leaky, "en");
  assertEquals(containsInternalTerminology(clean), false);
  assert(clean.trim().length > 0);
});

Deno.test("Customer policy: clean customer text is preserved", () => {
  const text = "Sure — could you tell me your order number so I can check it?";
  assertEquals(sanitizeCustomerFacingText(text, "en"), text);
});

Deno.test("Continuity: latest customer correction wins", () => {
  const signals = deriveContinuitySignals([
    { role: "visitor", content: "My order number is 100234" },
    { role: "assistant", content: "Thanks, checking order 100234." },
    { role: "visitor", content: "Sorry, actually the order number is 100567" },

  ]);
  assert(signals.latest_correction !== null);
  assert(signals.already_provided_details.length > 0);
});

Deno.test("Human control: waiting and assigned states are distinguished", () => {
  assertEquals(assessHumanControl({ status: "active", assigned_agent_id: null }).state, "none");
  assertEquals(assessHumanControl({ status: "human_needed", assigned_agent_id: null }).state, "waiting");
  const assigned = assessHumanControl({ status: "human_control", assigned_agent_id: "agent-1" });
  assertEquals(assigned.state, "assigned");
  assertEquals(assigned.ai_suppressed, true);
});

Deno.test("Routing: conversational and noise inputs never hand off", () => {
  assertEquals(classifyConversationalRoute("hello").kind, "conversational");
  assertEquals(classifyConversationalRoute("謝謝").kind, "conversational");
  assertEquals(classifyConversationalRoute("😀😀").kind, "clarify");
});

Deno.test("Routing: underspecified intent asks one clarifying question", () => {
  assert(isUnderspecifiedIntent("I have a problem with my order"));
  assert(isUnderspecifiedIntent("我的訂單有問題"));
  assertEquals(classifyConversationalRoute("I have a problem with my order").kind, "underspecified");
  assert(!isUnderspecifiedIntent("What is the refund window for order 5678 damaged on delivery?"));
});

Deno.test("Routing: substantive policy questions stay on the normal path", () => {
  assertEquals(classifyConversationalRoute("What is your refund policy for damaged goods?").kind, "normal");
});
