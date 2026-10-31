import { executionFailure, type ExecutionFailure } from "./execution-failure.ts";
/**
 * C3 request-budget and terminal-response guard.
 *
 * Supabase currently enforces a 150 second request idle timeout. The widget
 * poller uses a shorter product SLA, so orchestration gets a fixed 75 second
 * work budget and keeps 15 seconds for a deterministic, source-bound fallback.
 */
export const GENERATION_WORK_BUDGET_MS = 75_000;
export const GENERATION_TERMINAL_RESERVE_MS = 15_000;
export const GENERATION_RESPONSE_BUDGET_MS = GENERATION_WORK_BUDGET_MS +
  GENERATION_TERMINAL_RESERVE_MS;

export type TerminalDeadlineResult<T> =
  | { kind: "completed"; value: T }
  | { kind: "deadline"; value: T };

export async function runWithTerminalDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  onDeadline: () => Promise<T>,
  workBudgetMs = GENERATION_WORK_BUDGET_MS,
): Promise<TerminalDeadlineResult<T>> {
  if (!Number.isFinite(workBudgetMs) || workBudgetMs <= 0) {
    throw new Error("invalid_generation_work_budget");
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const workPromise = Promise.resolve()
    .then(() => work(controller.signal))
    .then((value) => ({ kind: "completed" as const, value }));
  const deadlinePromise = new Promise<{ kind: "deadline" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "deadline" }), workBudgetMs);
  });

  let winner: Awaited<typeof workPromise> | { kind: "deadline" };
  try {
    winner = await Promise.race([workPromise, deadlinePromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (winner.kind === "completed") return winner;

  controller.abort("generation_work_budget_exhausted");
  // The guarded database commit is source-idempotent. If in-flight work exits
  // after the fallback wins, its later commit cannot create a second reply.
  void workPromise.catch(() => undefined);
  return { kind: "deadline", value: await onDeadline() };
}

export function isRecoverableTerminalStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function isRecoverableTerminalError(error: unknown): boolean {
  if (typeof error !== "string") return false;
  return [
    "AI service error",
    "Internal KB processing error",
    "citation_lineage_unavailable",
    "prior_grounded_transform_lineage_unavailable",
    "semantic_interpretation_failed",
    "canonical_memory_commit_failed",
    "canonical_memory_unavailable",
    "canonical_memory_limits_exceeded",
    "commerce_state_unavailable",
  ].includes(error) ||
    /(?:^|_)b2_(?:block|indeterminate)$|^b2_supervision_(?:blocked|indeterminate)$/
      .test(error);
}

/** Classify an existing terminal outcome without echoing its route or details. */
export function terminalFailureDiagnostic(
  reason: unknown,
  options: Parameters<typeof executionFailure>[1] = {},
): ExecutionFailure {
  const label = typeof reason === "string" && reason.length <= 160 ? reason : "";
  const code = /(?:^|_)b2_block$|^b2_supervision_blocked$/.test(label)
    ? "B2_SUPERVISION_BLOCKED"
    : /(?:^|_)b2_indeterminate$|^b2_supervision_indeterminate$/.test(label)
    ? "B2_SUPERVISION_INDETERMINATE"
    : /^(?:commerce_state|canonical_memory|canonical_memory_commit)/.test(label)
    ? "PERSISTENCE_FAILED"
    : label === "generation_work_budget_exhausted" ? "LLM_TIMEOUT"
    : "SEMANTIC_INTERPRETER_UNAVAILABLE";
  return executionFailure(code, options);
}

/**
 * A deterministic historical-quote answer that preserves A3 authority while
 * avoiding a false "current price" claim at the frozen B2 persistence gate.
 * No amount is repeated and no present-day transaction fact is asserted.
 */
export function historicalQuoteValidityReply(
  language: "zh-TW" | "zh-CN" | "en",
): string {
  if (language === "zh-CN") {
    return "未必。你之前见过的数字只属过往参考，不能用作今天交易依据；实际收费及条件要先由官方资料或客服重新核实。";
  }
  if (language === "en") {
    return "Not necessarily. The earlier amount is historical reference only and cannot be used for today's transaction. Please recheck the applicable charges and conditions before relying on it.";
  }
  return "未必。你之前見過嘅數字只屬過往參考，不能用作今天交易依據；實際收費及條件要先由官方資料或客服重新核實。";
}

export function terminalRecoveryReply(
  language: "zh-TW" | "zh-CN" | "en",
  failure?: ExecutionFailure,
): string {
  if (failure && !failure.retryable) {
    if (language === "en") return "A system configuration or processing problem prevented this reply. Your question has not been resolved. You can request human support here; no transfer has been made yet.";
    if (language === "zh-CN") return "系统配置或处理出现问题，这次未能完成回复，你的问题仍未解决。你可以在这里要求人工客服；目前尚未转交。";
    return "系統設定或處理出現問題，今次未能完成回覆，你嘅問題仍未解決。你可以喺呢度要求真人客服；目前尚未轉交。";
  }
  if (language === "zh-CN") {
    return "抱歉，系统暂时未能处理这次消息。请稍后再试，或者直接要求人工客服协助。";
  }
  if (language === "en") {
    return "Sorry, a technical problem prevented me from processing this message. Please try again, or ask for a human support agent.";
  }
  return "抱歉，系統暫時未能處理呢次訊息。請稍後再試，或者直接要求真人客服協助。";
}
