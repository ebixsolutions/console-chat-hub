/**
 * Console copy + language selection.
 *
 * All console-facing strings live here. Components call useConsoleLang() and
 * read from COPY; no user-visible English or Chinese is written inline in JSX.
 *
 * The language preference is read from localStorage so it survives navigation,
 * and defaults to English when nothing is stored.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type ConsoleLang = "en" | "zh";

const STORAGE_KEY = "nexusai.console.lang";

export const COPY = {
  ce: {
    title: { en: "Conversation Evaluation", zh: "對話品質評估" },
    subtitle: {
      en: "Six-dimension scoring grounded in tenant knowledge and policy evidence.",
      zh: "以租戶知識庫與政策證據為依據的六維度評分。",
    },
    views: {
      all: { en: "All Conversations", zh: "全部對話" },
      needsReview: { en: "Needs Review", zh: "待覆核" },
      trainingReady: { en: "Training Ready", zh: "可送訓練" },
      trained: { en: "Trained", zh: "已送訓練" },
    },
    search: { en: "Search conversation or evaluation id", zh: "搜尋對話或評估 ID" },
    filters: {
      severity: { en: "Severity", zh: "嚴重度" },
      review: { en: "Review state", zh: "覆核狀態" },
      channel: { en: "Channel", zh: "渠道" },
      minScore: { en: "Min score", zh: "最低分" },
      maxScore: { en: "Max score", zh: "最高分" },
      from: { en: "From", zh: "起始日" },
      to: { en: "To", zh: "結束日" },
      any: { en: "Any", zh: "全部" },
      clear: { en: "Clear filters", zh: "清除篩選" },
    },
    table: {
      evaluated: { en: "Evaluated", zh: "評估時間" },
      conversation: { en: "Conversation", zh: "對話" },
      overall: { en: "Overall", zh: "總分" },
      severity: { en: "Severity", zh: "嚴重度" },
      review: { en: "Review", zh: "覆核" },
      training: { en: "Training", zh: "訓練" },
      open: { en: "Open", zh: "開啟" },
      close: { en: "Close", zh: "關閉" },
      empty: { en: "No evaluations match the current filters.", zh: "沒有符合目前篩選條件的評估。" },
      page: { en: "Page", zh: "第" },
      prev: { en: "Previous", zh: "上一頁" },
      next: { en: "Next", zh: "下一頁" },
    },
    run: {
      title: { en: "Run an evaluation", zh: "執行評估" },
      placeholder: { en: "Conversation ID (UUID)", zh: "對話 ID（UUID）" },
      submit: { en: "Evaluate", zh: "開始評估" },
      running: { en: "Evaluating…", zh: "評估中…" },
      hint: {
        en: "Six independent evaluators run against a hashed, tenant-scoped evidence bundle.",
        zh: "六個獨立評估器針對已雜湊、限定租戶的證據套件執行。",
      },
      invalidId: { en: "Enter a valid conversation id (UUID).", zh: "請輸入有效的對話 ID（UUID）。" },
    },
    tabs: {
      overview: { en: "Overview", zh: "總覽" },
      evaluation: { en: "Evaluation", zh: "評分明細" },
      attempts: { en: "Attempts", zh: "執行紀錄" },
      delivery: { en: "Training delivery", zh: "訓練派送" },
      audit: { en: "Audit history", zh: "稽核紀錄" },
      signals: { en: "Signals", zh: "訊號" },
      analysis: { en: "Analysis", zh: "分析" },
      integration: { en: "Integration", zh: "整合" },
      replay: { en: "Replay Studio", zh: "重播工作台" },
    },
    signals: {
      emotion: { en: "Emotion Journey", zh: "情緒歷程" },
      emotionEmpty: { en: "No emotion points recorded.", zh: "沒有情緒紀錄。" },
      nextSteps: { en: "Next Steps", zh: "後續行動" },
      nextStepsEmpty: { en: "No next steps recorded.", zh: "沒有後續行動。" },
      owner: { en: "Owner", zh: "負責角色" },
      trigger: { en: "Trigger", zh: "觸發原因" },
    },
    analysis: {
      discrepancy: { en: "Discrepancy Analysis", zh: "落差分析" },
      discrepancyEmpty: { en: "No discrepancies were derived.", zh: "沒有推導出落差。" },
      aiClaim: { en: "AI said", zh: "AI 回覆" },
      humanClaim: { en: "Human said", zh: "人工回覆" },
      groundedClaim: { en: "Evidence supports", zh: "證據支持" },
      rootCause: { en: "Root Cause Analysis", zh: "根因分析" },
      rootCauseEmpty: { en: "No root cause recorded.", zh: "沒有根因紀錄。" },
      category: { en: "Category", zh: "類別" },
      summary: { en: "Summary", zh: "摘要" },
      record: { en: "Record root cause", zh: "記錄根因" },
      qaCase: { en: "QA Case", zh: "QA 案件" },
      qaCaseEmpty: { en: "No QA case linked.", zh: "尚未連結 QA 案件。" },
      qaTitle: { en: "Case title", zh: "案件標題" },
      createCase: { en: "Create QA case", zh: "建立 QA 案件" },
    },
    integration: {
      replayTitle: { en: "Replay Studio", zh: "重播工作台" },
      replayEmpty: { en: "No immutable snapshot stored for this evaluation.", zh: "此評估沒有不可變快照。" },
      replayHint: {
        en: "The stored snapshot is what the evaluators actually read. It is redacted and immutable.",
        zh: "此快照即評估器實際讀取的內容，已去識別化且不可修改。",
      },
      retention: { en: "Retained until", zh: "保留至" },
      training: { en: "Training candidate", zh: "訓練候選" },
      kbGap: { en: "KB gap", zh: "知識庫缺口" },
      improved: { en: "Improved final result", zh: "改善後結果" },
      improvedPending: {
        en: "Pending. The improved result arrives from the training round trip.",
        zh: "等待中。改善後結果將由訓練回路回傳。",
      },
      kbPublish: { en: "KB publish / rollback", zh: "知識庫發布／回滾" },
      kbPublishEmpty: { en: "No publish or rollback requested.", zh: "尚未提出發布或回滾。" },
      docRef: { en: "KB document reference", zh: "知識庫文件參照" },
      publish: { en: "Request publish", zh: "請求發布" },
      rollback: { en: "Request rollback", zh: "請求回滾" },
      remoteSync: { en: "Remote sync", zh: "遠端同步" },
      remoteBlocked: {
        en: "Remote sync to Nexus KB and SU Coach AI is pending; local state is authoritative.",
        zh: "與 Nexus KB 及 SU Coach AI 的遠端同步待處理；以本地狀態為準。",
      },
      recorded: { en: "Recorded", zh: "已記錄" },
    },
    overview: {
      aiReply: { en: "Evaluated AI reply", zh: "受評 AI 回覆" },
      humanReply: { en: "Verified human response", zh: "已驗證人工回覆" },
      noHuman: { en: "No identity-verified human response in this conversation.", zh: "此對話沒有已驗證身分的人工回覆。" },
      noAi: { en: "No AI reply found in this conversation.", zh: "此對話沒有 AI 回覆。" },
      transcript: { en: "Transcript", zh: "對話內容" },
      liveWarning: {
        en: "Live transcript. The evaluation was scored against a frozen snapshot; the integrity check below compares them.",
        zh: "此為即時對話內容。評分依據為凍結快照，下方完整性檢查會比對兩者。",
      },
      integrityOk: { en: "Transcript matches the evaluated snapshot.", zh: "對話內容與受評快照一致。" },
      integrityDrift: {
        en: "Transcript has changed since this evaluation. Scores refer to the earlier snapshot.",
        zh: "此對話在評估後已變動。分數對應的是先前的快照。",
      },
      integrityUnknown: { en: "Integrity check unavailable in this browser.", zh: "此瀏覽器無法執行完整性檢查。" },
    },
    provenance: {
      title: { en: "Provenance", zh: "來源紀錄" },
      contract: { en: "Contract", zh: "合約版本" },
      model: { en: "Model", zh: "模型" },
      prompt: { en: "Prompt", zh: "提示詞版本" },
      deployment: { en: "Deployment", zh: "部署" },
      kbSnapshot: { en: "KB evidence hash", zh: "知識庫證據雜湊" },
      policySnapshot: { en: "Policy evidence hash", zh: "政策證據雜湊" },
      bundle: { en: "Bundle hash", zh: "套件雜湊" },
      snapshot: { en: "Snapshot hash", zh: "快照雜湊" },
      verifiedHuman: { en: "Verified human response", zh: "已驗證人工回覆" },
      trainingEligible: { en: "Training eligible", zh: "符合訓練條件" },
      yes: { en: "yes", zh: "是" },
      no: { en: "no", zh: "否" },
    },
    detail: {
      breakdown: { en: "Score breakdown", zh: "評分明細" },
      justification: { en: "Justification", zh: "評分理由" },
      correction: { en: "Recommended correction", zh: "建議修正" },
      refs: { en: "Grounding", zh: "依據來源" },
      none: { en: "None recorded.", zh: "無紀錄。" },
      noDetails: { en: "No per-dimension detail rows were recorded.", zh: "沒有逐維度明細紀錄。" },
    },
    attempts: {
      empty: { en: "No attempts recorded for this conversation.", zh: "此對話沒有執行紀錄。" },
      retry: { en: "Retry evaluation", zh: "重新評估" },
      status: { en: "Status", zh: "狀態" },
      error: { en: "Error", zh: "錯誤" },
      started: { en: "Started", zh: "開始時間" },
    },
    delivery: {
      empty: { en: "Not queued for training.", zh: "尚未排入訓練佇列。" },
      restricted: { en: "Delivery state is visible to admin and supervisor only.", zh: "派送狀態僅限管理員與主管檢視。" },
      attempts: { en: "Attempts", zh: "嘗試次數" },
      delivered: { en: "Delivered", zh: "已派送" },
      sendToTraining: { en: "Send to training", zh: "送交訓練" },
      sendHint: {
        en: "Accepting a training-eligible evaluation enqueues it in the same transaction.",
        zh: "接受符合訓練條件的評估時，會在同一交易內排入佇列。",
      },
    },
    audit: {
      empty: { en: "No audit entries for this evaluation.", zh: "此評估沒有稽核紀錄。" },
      actor: { en: "Actor", zh: "操作者" },
      action: { en: "Action", zh: "動作" },
      when: { en: "When", zh: "時間" },
    },
    review: {
      title: { en: "Review decision", zh: "覆核決定" },
      current: { en: "Current", zh: "目前狀態" },
      notePlaceholder: {
        en: "Reviewer note (required when rejecting, max 1000 characters)",
        zh: "覆核備註（拒絕時必填，上限 1000 字）",
      },
      accept: { en: "Accept", zh: "接受" },
      reject: { en: "Reject", zh: "拒絕" },
      reopen: { en: "Reopen", zh: "重新開啟" },
      readOnly: {
        en: "Read-only. Recording a decision requires an admin or supervisor role in this company.",
        zh: "唯讀。記錄決定需具備本公司的管理員或主管角色。",
      },
      noteRequired: { en: "A note is required when rejecting.", zh: "拒絕時必須填寫備註。" },
      recorded: { en: "Review recorded", zh: "已記錄覆核" },
    },
    errors: {
      invalid_request: { en: "The request was rejected as invalid.", zh: "請求無效，已被拒絕。" },
      unauthorized: { en: "Your session is not valid. Sign in again.", zh: "工作階段無效，請重新登入。" },
      forbidden: { en: "You do not have access to this company or action.", zh: "您沒有此公司或此操作的權限。" },
      not_found: { en: "The record was not found.", zh: "找不到該筆紀錄。" },
      conflict: { en: "The request conflicts with the current state.", zh: "請求與目前狀態衝突。" },
      payload_too_large: { en: "The conversation is too large to evaluate.", zh: "此對話過大，無法評估。" },
      provider_failed: { en: "The evaluation provider failed. Try again.", zh: "評估服務失敗，請重試。" },
      unavailable: { en: "The evaluation service is not available right now.", zh: "評估服務目前無法使用。" },
      internal_error: { en: "Something went wrong. Try again.", zh: "發生錯誤，請重試。" },
      unknown: { en: "The request could not be completed.", zh: "無法完成此請求。" },
    },
    permissionDenied: {
      en: "Conversation Evaluation requires an assigned console role.",
      zh: "對話品質評估需要指派的 Console 角色。",
    },
  },
} as const;

type LangValue = { en: string; zh: string };

const LangContext = createContext<ConsoleLang>("en");

export function ConsoleLangProvider({ lang, children }: { lang: ConsoleLang; children: React.ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useConsoleLang() {
  const contextLang = useContext(LangContext);
  const [lang, setLang] = useState<ConsoleLang>(contextLang);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "en" || stored === "zh") setLang(stored);
    } catch {
      /* storage unavailable — keep the context default */
    }
  }, []);

  const change = useCallback((next: ConsoleLang) => {
    setLang(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback((value: LangValue) => value[lang] ?? value.en, [lang]);

  return useMemo(() => ({ lang, setLang: change, t }), [lang, change, t]);
}
