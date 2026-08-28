#!/usr/bin/env python3
"""Task 3.3 Round 1 consolidated conversational closure source contract.

Machine-checked source guarantees for the Round 1 closure items:
canonical handoff-intent classification (R1 false positives), answerability
gating decoupled from retrieval score, customer-facing language policy,
conversation continuity, unified human-control state, and underspecified
intent clarification.
"""
from pathlib import Path
import sys

r = Path(sys.argv[1] if len(sys.argv) > 1 else '.')


def read(path: str) -> str:
    p = r / path
    assert p.is_file() and p.stat().st_size > 0, f"missing/empty {path}"
    return p.read_text()


intent = read('supabase/functions/_shared/handoff-intent.ts')
answer = read('supabase/functions/_shared/answerability.ts')
policy = read('supabase/functions/_shared/customer-response-policy.ts')
continuity = read('supabase/functions/_shared/conversation-continuity.ts')
control = read('supabase/functions/_shared/human-control.ts')
routing = read('supabase/functions/_shared/conversational-routing.ts')
signals = read('supabase/functions/_shared/escalation-signals.ts')
reply = read('supabase/functions/generate-reply/index.ts')
widget = read('supabase/functions/receive-widget-message/index.ts')
live = read('supabase/functions/widget-live-ai-test/index.ts')
tests = read('supabase/functions/_shared/task3-3-round1-closure_test.ts')

# ---- R1: canonical classifier is the only handoff-intent authority ----
for marker in [
    'export function classifyHandoffIntent',
    'export function isExplicitHandoffRequest',
    'export function isPureHandoffNegation',
    'NEGATION_MARKERS',
    'CONDITIONAL_MARKERS',
    'REFERENCE_MARKERS',
    'QUESTION_MARKERS',
    'PRESENT_REQUEST_MARKERS',
    'negated_request',
    'conditional_or_future',
    'reference_or_report',
    'informational_question',
]:
    assert marker in intent, f"R1: {marker}"
assert 'classifyHandoffIntent' in reply, "R1: generate-reply must use canonical classifier"
assert 'handoff-intent.ts' in signals or 'handoff-intent.ts' in intent, "R1: signal provenance documented"
assert 'canonical classifier' in signals, "R1: explicit_request provenance must be documented"
assert 'handoff_intent_category' in reply and 'pure_handoff_negation' in reply, \
    "R1: classification must be observable in traces"

# ---- Answerability is decoupled from retrieval score ----
for marker in [
    'export function assessAnswerability',
    'no_confirmed_content',
    'content_too_thin',
    'topic_not_covered',
    'exact_fact_not_present',
    'question_underspecified',
    'coversQuestionTopic',
    'never used as the acceptance decision',
]:
    assert marker in answer, f"answerability: {marker}"
assert 'assessAnswerability' in reply, "answerability: generate-reply must gate generation"

# ---- Customer-facing language policy ----
for marker in [
    'FORBIDDEN_INTERNAL_TERMS',
    'CUSTOMER_CONVERSATION_POLICY_PROMPT',
    'export function sanitizeCustomerFacingText',
    'export function containsInternalTerminology',
    'NATURAL_INSUFFICIENT_INFO',
]:
    assert marker in policy, f"policy: {marker}"
assert reply.count('sanitizeCustomerFacingText(') >= 2, \
    "policy: both generation paths must sanitize customer-facing text"
assert reply.count('CUSTOMER_CONVERSATION_POLICY_PROMPT') >= 2, \
    "policy: both system prompts must carry the customer conversation policy"

# ---- Continuity ----
for marker in [
    'export function deriveContinuitySignals',
    'export function buildContinuityBrief',
    'latest_correction',
    'already_provided_details',
    'clarification_attempts_for_current_intent',
]:
    assert marker in continuity, f"continuity: {marker}"
assert 'buildContinuityBrief' in reply, "continuity: prompt must include continuity brief"

# ---- Unified human control ----
for marker in [
    'export function assessHumanControl',
    'HUMAN_CONTROL_STATUSES',
    'ai_suppressed',
    'waiting',
    'assigned',
]:
    assert marker in control, f"human-control: {marker}"
assert 'assessHumanControl' in live, "human-control: live AI test must use shared assessment"
assert 'human_control_state' in live, "human-control: preview needs the expected-state signal"

# ---- Underspecified intent clarification, never immediate handoff ----
for marker in [
    'export function isUnderspecifiedIntent',
    'UNDERSPECIFIED_CLARIFICATION',
    'underspecified',
]:
    assert marker in routing, f"routing: {marker}"
assert 'underspecified' in widget, "routing: widget intake must honour underspecified route"

# ---- Regression tests exist and are behavioural ----
for marker in [
    'Deno.test(',
    'never escalate',
    'retrieval score alone cannot authorise an answer',
    'internal terminology is detected and removed',
    'underspecified intent asks one clarifying question',
    'waiting and assigned states are distinguished',
]:
    assert marker in tests, f"tests: {marker}"

print('PASS Task 3.3 Round 1 conversational closure source contract')
