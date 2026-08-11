今天 上午10:35
另外，小心深入讀一下 project memory、Base44，及 Lovable
之前不是已提出Base44 的 SU CoachAI's Conversation  (圖二)，必須完整移植整個邏輯功能及100% 介面到 Lovable 的 AI Chatbot's Conversation Evaluation  (圖一)，除了相關 training 功能 (例如 training ready) 必須交回 SU Coach 負責外

之前好像已安排修改，但介面仍是舊的
必須介面完全對齊原設計，但刪除所有有關 traing 功能
 
Lovable preview 制新後的介面仍不是對齊左邊的 Base44 SU coachAI 原設計
為什麼沒有正確讀取 AI Chatbot 上的客戶對話？
右方仍沒有顯示對應的 Title、評分 、及 5 x buttons 及所有相關資料？
是否後端邏輯已完整做好？
下次不要直接使用 lovable chat，先出指示給 Supervisor 產出完整替換 code，二次不pass 後由你 takeover

files (1)(2).zip
壓縮封存檔案
/instruction 驗收一下
files (2)(2).zip
壓縮封存檔案
/instruction 驗收一下，如未能 pass 請 takeover
今天 下午1:02
這三個都顯示報錯

├─ console.conversation-evaluation.index.tsx 
├─ CeDetailPanel.tsx 
└─ ceReviewCopy.ts
處理時間為 4m 54s

已確認：目前三張 Build unsuccessful 的共同 root cause 是同一個 cross-file compile error，不是三個獨立錯誤。

CeDetailPanel.tsx 仍然有：

t(C.detail.back)

但 Supervisor Round 2／Director Takeover R1 的 ceReviewCopy.ts 誤刪了：

back: {
  en: "Back to Conversation Evaluation",
  zh: "返回對話評估"
}

因此每次你在 Lovable Code Editor 儲存一個檔案，它都重新 build 整個 project，所以連續三次都顯示 Build unsuccessful。

已完成 Director build fix

這次只需要替換 1 個檔案：

src/lib/i18n/ceReviewCopy.ts

我沒有再修改：

console.conversation-evaluation.index.tsx
CeDetailPanel.tsx
ce.functions.ts
package.json
Supabase
DB/schema

已執行：

TypeScript syntax parse
PASS

CeDetailPanel + Conversation Evaluation route
→ CE_REVIEW_COPY cross-file key scan
PASS

missing C.* keys
0

修正版 ceReviewCopy.ts SHA256：

2aef3b6c47d2404044b3ca44be2f1649e0726abcc9bdf62febb1bcba7ce5e527

你現在只需把這個完整 replacement file 放回 Lovable：

下載修正版 ceReviewCopy.ts

或完整 build-fix package：

下載 PR4_CE_DIRECTOR_BUILD_FIX_R2.zip

Package SHA256：

407647515af05b418f4b313325fd18937887346f85f25cece8c8d24111951489

目前狀態仍是 FAIL — FIX PREPARED，不是 READY。 要等你替換這一個檔案後，Lovable 顯示最新一次 Build successful，我才會把這個 compile gate 判 PASS。不要按 Fix build，也不用再用 Lovable Chat。

ceReviewCopy.ts
程式碼
查一下 Lovable 是否更新後有沒有錯誤
處理時間為 40s

我剛直接查了 Lovable live source：目前仍有錯誤，而且你上一個修正版尚未真正更新到 Lovable。

目前 live 狀態是：

最新 Code Editor commit 仍停在 2026-08-11 05:01:19 UTC
src/lib/i18n/ceReviewCopy.ts 目前的 detail 內 仍然沒有 back

src/components/console/ce/CeDetailPanel.tsx 最底仍然存在：

t(C.detail.back)
所以這個 TypeScript/build error 仍然存在。

也就是：

CeDetailPanel.tsx
      ↓ calls
C.detail.back
      ↓
ceReviewCopy.ts
      ↓
back DOES NOT EXIST
      ↓
BUILD FAIL
裁決

FAIL — Lovable 尚未套用上一個 ceReviewCopy.ts 修正版。

現在只要重新替換這 1 個 live file：

src/lib/i18n/ceReviewCopy.ts

用這個版本：

下載正確 ceReviewCopy.ts

其他兩個檔案先不要再動，也不要按 Fix build。

你貼入並 Save 後，我可以立即再直接查 Lovable，確認最新 commit + live source 是否真的已更新，以及還有沒有下一個 build error。

ceReviewCopy.ts
程式碼
更新了仍顯示報錯
處理時間為 36s

已查清楚：你更新後仍報錯，是因為 ceReviewCopy.ts 被貼錯內容了。

Lovable 目前 HEAD 的 src/lib/i18n/ceReviewCopy.ts 開頭實際變成：

今天 上午10:35
另外，小心深入讀一下 project memory、Base44，及 Lovable
之前不是已提出...

也就是整段聊天記錄、說明、hash、舊回覆都被貼進 .ts 檔案，這一定會直接造成 TypeScript/Vite compile failure。

我亦同步核對了：

console.conversation-evaluation.index.tsx：目前仍是正常 TypeScript source
CeDetailPanel.tsx：目前仍是正常 TypeScript source
ce.functions.ts：目前仍是正常 TypeScript source
真正立即阻塞 build 的是 ceReviewCopy.ts 已被污染

所以這次不要再改另外三個檔案，只做一件事：

完整清空 Lovable 的

src/lib/i18n/ceReviewCopy.ts

然後用下面這個檔案的全部內容完整覆蓋，不要連同聊天文字一起複製：

下載乾淨版 ceReviewCopy.ts

這個正確檔案開頭應該直接是：

/**
 * CE review console copy — PR-4 Round 2.
 * No training wording. Bilingual.
 */

export type LangValue = { en: string; zh: string };

export const CE_REVIEW_COPY = {

而且它的 detail 內已包含：

back: {
  en: "Back to Conversation Evaluation",
  zh: "返回對話評估",
},

不要按 Lovable 的 Fix build，也不要用 Lovable Chat。

你 Save 之後告訴我，我會再直接讀 Lovable HEAD；這次我會先確認 live ceReviewCopy.ts 第一行確實是 /**，再繼續檢查是否還有下一個真實 build error。

ceReviewCopy.ts
程式碼

檔案庫
/
AI Commerce Coach Project
/
ceReviewCopy.ts
/**
 * CE review console copy — PR-4 Round 2.
 * No training wording. Bilingual.
 */

export type LangValue = { en: string; zh: string };

export const CE_REVIEW_COPY = {
  pills: {
    all: { en: "All Conversations", zh: "全部對話" },
    needsReview: { en: "Needs Review", zh: "待覆核" },
    evaluated: { en: "Evaluated", zh: "已評估" },
    notEvaluated: { en: "Not Evaluated", zh: "未評估" },
  },
  count: { en: "shown", zh: "顯示" },
  countUnavailable: { en: "Counts unavailable", zh: "數量無法取得" },
  searchPlaceholder: { en: "Search customer, conversation ID, or message", zh: "搜尋客戶、對話 ID 或訊息" },
  filters: {
    status: { en: "Review", zh: "覆核狀態" },
    urgency: { en: "Urgency", zh: "嚴重度" },
    score: { en: "Score", zh: "分數" },
    channel: { en: "Channel", zh: "渠道" },
    intent: { en: "Intent", zh: "意圖" },
    more: { en: "More filters", zh: "更多篩選" },
    less: { en: "Fewer filters", zh: "收起篩選" },
    any: { en: "All", zh: "全部" },
    from: { en: "From", zh: "起始日" },
    to: { en: "To", zh: "結束日" },
    clear: { en: "Clear", zh: "清除" },
    unavailable: { en: "Unavailable", zh: "無資料" },
  },
  scoreBands: {
    low: { en: "< 60", zh: "< 60" },
    mid: { en: "60 – 79", zh: "60 – 79" },
    high: { en: "80 +", zh: "80 +" },
  },
  columns: {
    id: { en: "ID", zh: "ID" },
    customer: { en: "Customer", zh: "客戶" },
    date: { en: "Date", zh: "日期" },
    channel: { en: "Channel", zh: "渠道" },
    convStatus: { en: "Conv.", zh: "對話" },
    qaScore: { en: "QA Score", zh: "QA 分數" },
    urgency: { en: "Urgency", zh: "嚴重度" },
    status: { en: "Status", zh: "狀態" },
  },
  list: {
    empty: { en: "No conversations match the current filters.", zh: "沒有符合目前篩選條件的對話。" },
    loadFailed: { en: "The conversation list could not be loaded.", zh: "無法載入對話清單。" },
    prev: { en: "Previous", zh: "上一頁" },
    next: { en: "Next", zh: "下一頁" },
    page: { en: "Page", zh: "頁次" },
  },
  run: {
    action: { en: "Evaluate", zh: "執行評估" },
    running: { en: "Evaluating…", zh: "評估中…" },
    placeholder: { en: "Conversation ID (UUID)", zh: "對話 ID（UUID）" },
    invalidId: { en: "Enter a valid conversation id (UUID).", zh: "請輸入有效的對話 ID（UUID）。" },
    completed: { en: "Evaluation completed.", zh: "評估已完成。" },
    alreadyEvaluated: { en: "This conversation was already evaluated.", zh: "此對話先前已評估過。" },
    disabled: {
      en: "Evaluation unavailable until SU Platform company identity is connected.",
      zh: "在 SU 平台企業身份連接前，評估功能暫時無法使用。",
    },
  },
  detail: {
    selectPrompt: { en: "Select a conversation to review.", zh: "請選擇一筆對話以進行檢視。" },
    back: { en: "Back to Conversation Evaluation", zh: "返回對話評估" },
    loading: { en: "Loading…", zh: "載入中…" },
    loadFailed: { en: "This conversation could not be loaded.", zh: "無法載入此對話。" },
    sectionLoadFailed: { en: "This section could not be loaded.", zh: "無法載入此區段。" },
    notEvaluated: { en: "Not Evaluated", zh: "未評估" },
    notEvaluatedYet: { en: "Not evaluated yet.", zh: "尚未評估。" },
    evaluateUnavailable: {
      en: "Evaluation unavailable until SU Platform company identity is connected.",
      zh: "在 SU 平台企業身份連接前，評估功能暫時無法使用。",
    },
    replayUnavailable: { en: "Replay unavailable until evaluation is completed.", zh: "完成評估後才可使用重播功能。" },
    recalled: { en: "[Message recalled]", zh: "[訊息已撤回]" },
  },
  tabs: {
    overview: { en: "Overview", zh: "總覽" },
    evaluation: { en: "Evaluation", zh: "評估" },
    emotion: { en: "Emotion Journey", zh: "情緒歷程" },
    nextSteps: { en: "Next Steps", zh: "後續行動" },
    replay: { en: "Replay Studio", zh: "重播工作室" },
  },
  meta: {
    date: { en: "Date", zh: "日期" },
    tier: { en: "Customer Tier", zh: "客戶層級" },
    intent: { en: "Intent", zh: "意圖" },
    language: { en: "Language", zh: "語言" },
    unavailable: { en: "Unavailable", zh: "無資料" },
  },
  overview: {
    thread: { en: "Conversation Thread", zh: "對話內容" },
    customer: { en: "Customer", zh: "客戶" },
    aiResponse: { en: "AI Response", zh: "AI 回覆" },
    humanAgent: { en: "Human Agent", zh: "人工客服" },
    qaFinding: { en: "QA Finding", zh: "QA 發現" },
    humanCorrection: { en: "Verified Human Correction", zh: "已驗證人工修正" },
    noThread: { en: "No messages available for this conversation.", zh: "此對話沒有可顯示的訊息。" },
    liveNote: { en: "Live transcript. Scores refer to the frozen snapshot.", zh: "即時對話內容，分數依據為凍結快照。" },
    qaCases: { en: "QA Cases", zh: "QA 案件" },
    qaCasesEmpty: { en: "No QA case linked.", zh: "尚未連結 QA 案件。" },
    qaCaseTitle: { en: "Case title", zh: "案件標題" },
    createQaCase: { en: "Create QA case", zh: "建立 QA 案件" },
    discrepancy: { en: "Discrepancy Analysis", zh: "落差分析" },
    discrepancyEmpty: { en: "No discrepancies derived.", zh: "沒有推導出落差。" },
    aiClaim: { en: "AI said", zh: "AI 回覆" },
    humanClaim: { en: "Human said", zh: "人工回覆" },
    groundedClaim: { en: "Evidence supports", zh: "證據支持" },
    rootCause: { en: "Root Cause Analysis", zh: "根因分析" },
    rootCauseEmpty: { en: "No root cause recorded.", zh: "沒有根因紀錄。" },
    rootCauseSummary: { en: "Summary", zh: "摘要" },
    recordRootCause: { en: "Record root cause", zh: "記錄根因" },
    remoteSync: { en: "Remote sync", zh: "遠端同步" },
  },
  evaluation: {
    breakdown: { en: "Score breakdown", zh: "評分明細" },
    noDetails: { en: "No per-dimension detail rows.", zh: "沒有逐維度明細。" },
    justification: { en: "Justification", zh: "評分理由" },
    correction: { en: "Recommended correction", zh: "建議修正" },
    refs: { en: "Grounding", zh: "依據來源" },
    none: { en: "None recorded.", zh: "無紀錄。" },
    provenance: { en: "Provenance", zh: "來源紀錄" },
    contract: { en: "Contract", zh: "合約版本" },
    model: { en: "Model", zh: "模型" },
    prompt: { en: "Prompt", zh: "提示詞版本" },
    deployment: { en: "Deployment", zh: "部署" },
    kb: { en: "KB evidence hash", zh: "知識庫證據雜湊" },
    policy: { en: "Policy evidence hash", zh: "政策證據雜湊" },
    bundle: { en: "Bundle hash", zh: "套件雜湊" },
    snapshot: { en: "Snapshot hash", zh: "快照雜湊" },
    review: { en: "Review decision", zh: "覆核決定" },
    current: { en: "Current", zh: "目前狀態" },
    accept: { en: "Accept", zh: "接受" },
    reject: { en: "Reject", zh: "拒絕" },
    reopen: { en: "Reopen", zh: "重新開啟" },
    note: { en: "Reviewer note (required for reject, max 1000 chars)", zh: "覆核備註（拒絕時必填，上限 1000 字）" },
    noteRequired: { en: "A note is required when rejecting.", zh: "拒絕時必須填寫備註。" },
    readOnly: { en: "Read-only: requires admin or supervisor role.", zh: "唯讀，需管理員或主管角色。" },
  },
  emotion: {
    empty: { en: "No emotion points recorded.", zh: "沒有情緒紀錄。" },
    trigger: { en: "Trigger", zh: "觸發原因" },
    turn: { en: "Turn", zh: "輪次" },
  },
  nextSteps: {
    empty: { en: "No next steps recorded.", zh: "沒有後續行動。" },
    owner: { en: "Owner", zh: "負責角色" },
  },
  replay: {
    unavailable: { en: "No stored replay bundle for this attempt.", zh: "此次評估沒有儲存的重播內容。" },
    hint: { en: "The stored snapshot is what evaluators actually read. It is redacted and immutable.", zh: "此快照即評估器實際讀取的內容，已去識別化且不可修改。" },
    transcript: { en: "Transcript", zh: "對話" },
    canonical: { en: "Canonical Input", zh: "標準輸入" },
    grounding: { en: "Grounding Evidence", zh: "依據證據" },
    retention: { en: "Retained until", zh: "保留至" },
    rawAdminOnly: { en: "Raw evaluator payload is admin-only.", zh: "原始評估器內容僅限管理員。" },
    kbEvidence: { en: "KB evidence", zh: "知識庫證據" },
    policyEvidence: { en: "Policy evidence", zh: "政策證據" },
  },
} as const;

檔案庫
/
AI Commerce Coach Project
/
ceReviewCopy.ts
/**
 * CE review console copy — PR-4 Round 2.
 * No training wording. Bilingual.
 */

export type LangValue = { en: string; zh: string };

export const CE_REVIEW_COPY = {
  pills: {
    all: { en: "All Conversations", zh: "全部對話" },
    needsReview: { en: "Needs Review", zh: "待覆核" },
    evaluated: { en: "Evaluated", zh: "已評估" },
    notEvaluated: { en: "Not Evaluated", zh: "未評估" },
  },
  count: { en: "shown", zh: "顯示" },
  countUnavailable: { en: "Counts unavailable", zh: "數量無法取得" },
  searchPlaceholder: { en: "Search customer, conversation ID, or message", zh: "搜尋客戶、對話 ID 或訊息" },
  filters: {
    status: { en: "Review", zh: "覆核狀態" },
    urgency: { en: "Urgency", zh: "嚴重度" },
    score: { en: "Score", zh: "分數" },
    channel: { en: "Channel", zh: "渠道" },
    intent: { en: "Intent", zh: "意圖" },
    more: { en: "More filters", zh: "更多篩選" },
    less: { en: "Fewer filters", zh: "收起篩選" },
    any: { en: "All", zh: "全部" },
    from: { en: "From", zh: "起始日" },
    to: { en: "To", zh: "結束日" },
    clear: { en: "Clear", zh: "清除" },
    unavailable: { en: "Unavailable", zh: "無資料" },
  },
  scoreBands: {
    low: { en: "< 60", zh: "< 60" },
    mid: { en: "60 – 79", zh: "60 – 79" },
    high: { en: "80 +", zh: "80 +" },
  },
  columns: {
    id: { en: "ID", zh: "ID" },
    customer: { en: "Customer", zh: "客戶" },
    date: { en: "Date", zh: "日期" },
    channel: { en: "Channel", zh: "渠道" },
    convStatus: { en: "Conv.", zh: "對話" },
    qaScore: { en: "QA Score", zh: "QA 分數" },
    urgency: { en: "Urgency", zh: "嚴重度" },
    status: { en: "Status", zh: "狀態" },
  },
  list: {
    empty: { en: "No conversations match the current filters.", zh: "沒有符合目前篩選條件的對話。" },
    loadFailed: { en: "The conversation list could not be loaded.", zh: "無法載入對話清單。" },
    prev: { en: "Previous", zh: "上一頁" },
    next: { en: "Next", zh: "下一頁" },
    page: { en: "Page", zh: "頁次" },
  },
  run: {
    action: { en: "Evaluate", zh: "執行評估" },
    running: { en: "Evaluating…", zh: "評估中…" },
    placeholder: { en: "Conversation ID (UUID)", zh: "對話 ID（UUID）" },
    invalidId: { en: "Enter a valid conversation id (UUID).", zh: "請輸入有效的對話 ID（UUID）。" },
    completed: { en: "Evaluation completed.", zh: "評估已完成。" },
    alreadyEvaluated: { en: "This conversation was already evaluated.", zh: "此對話先前已評估過。" },
    disabled: {
      en: "Evaluation unavailable until SU Platform company identity is connected.",
      zh: "在 SU 平台企業身份連接前，評估功能暫時無法使用。",
    },
  },
  detail: {
    selectPrompt: { en: "Select a conversation to review.", zh: "請選擇一筆對話以進行檢視。" },
    back: { en: "Back to Conversation Evaluation", zh: "返回對話評估" },
    loading: { en: "Loading…", zh: "載入中…" },
    loadFailed: { en: "This conversation could not be loaded.", zh: "無法載入此對話。" },
    sectionLoadFailed: { en: "This section could not be loaded.", zh: "無法載入此區段。" },
    notEvaluated: { en: "Not Evaluated", zh: "未評估" },
    notEvaluatedYet: { en: "Not evaluated yet.", zh: "尚未評估。" },
    evaluateUnavailable: {
      en: "Evaluation unavailable until SU Platform company identity is connected.",
      zh: "在 SU 平台企業身份連接前，評估功能暫時無法使用。",
    },
    replayUnavailable: { en: "Replay unavailable until evaluation is completed.", zh: "完成評估後才可使用重播功能。" },
    recalled: { en: "[Message recalled]", zh: "[訊息已撤回]" },
  },
  tabs: {
    overview: { en: "Overview", zh: "總覽" },
    evaluation: { en: "Evaluation", zh: "評估" },
    emotion: { en: "Emotion Journey", zh: "情緒歷程" },
    nextSteps: { en: "Next Steps", zh: "後續行動" },
    replay: { en: "Replay Studio", zh: "重播工作室" },
  },
  meta: {
    date: { en: "Date", zh: "日期" },
    tier: { en: "Customer Tier", zh: "客戶層級" },
    intent: { en: "Intent", zh: "意圖" },
    language: { en: "Language", zh: "語言" },
    unavailable: { en: "Unavailable", zh: "無資料" },
  },
  overview: {
    thread: { en: "Conversation Thread", zh: "對話內容" },
    customer: { en: "Customer", zh: "客戶" },
    aiResponse: { en: "AI Response", zh: "AI 回覆" },
    humanAgent: { en: "Human Agent", zh: "人工客服" },
    qaFinding: { en: "QA Finding", zh: "QA 發現" },
    humanCorrection: { en: "Verified Human Correction", zh: "已驗證人工修正" },
    noThread: { en: "No messages available for this conversation.", zh: "此對話沒有可顯示的訊息。" },
    liveNote: { en: "Live transcript. Scores refer to the frozen snapshot.", zh: "即時對話內容，分數依據為凍結快照。" },
    qaCases: { en: "QA Cases", zh: "QA 案件" },
    qaCasesEmpty: { en: "No QA case linked.", zh: "尚未連結 QA 案件。" },
    qaCaseTitle: { en: "Case title", zh: "案件標題" },
    createQaCase: { en: "Create QA case", zh: "建立 QA 案件" },
    discrepancy: { en: "Discrepancy Analysis", zh: "落差分析" },
    discrepancyEmpty: { en: "No discrepancies derived.", zh: "沒有推導出落差。" },
    aiClaim: { en: "AI said", zh: "AI 回覆" },
    humanClaim: { en: "Human said", zh: "人工回覆" },
    groundedClaim: { en: "Evidence supports", zh: "證據支持" },
    rootCause: { en: "Root Cause Analysis", zh: "根因分析" },
    rootCauseEmpty: { en: "No root cause recorded.", zh: "沒有根因紀錄。" },
    rootCauseSummary: { en: "Summary", zh: "摘要" },
    recordRootCause: { en: "Record root cause", zh: "記錄根因" },
    remoteSync: { en: "Remote sync", zh: "遠端同步" },
  },
  evaluation: {
    breakdown: { en: "Score breakdown", zh: "評分明細" },
    noDetails: { en: "No per-dimension detail rows.", zh: "沒有逐維度明細。" },
    justification: { en: "Justification", zh: "評分理由" },
    correction: { en: "Recommended correction", zh: "建議修正" },
    refs: { en: "Grounding", zh: "依據來源" },
    none: { en: "None recorded.", zh: "無紀錄。" },
    provenance: { en: "Provenance", zh: "來源紀錄" },
    contract: { en: "Contract", zh: "合約版本" },
    model: { en: "Model", zh: "模型" },
    prompt: { en: "Prompt", zh: "提示詞版本" },
    deployment: { en: "Deployment", zh: "部署" },
    kb: { en: "KB evidence hash", zh: "知識庫證據雜湊" },
    policy: { en: "Policy evidence hash", zh: "政策證據雜湊" },
    bundle: { en: "Bundle hash", zh: "套件雜湊" },
    snapshot: { en: "Snapshot hash", zh: "快照雜湊" },
    review: { en: "Review decision", zh: "覆核決定" },
    current: { en: "Current", zh: "目前狀態" },
    accept: { en: "Accept", zh: "接受" },
    reject: { en: "Reject", zh: "拒絕" },
    reopen: { en: "Reopen", zh: "重新開啟" },
    note: { en: "Reviewer note (required for reject, max 1000 chars)", zh: "覆核備註（拒絕時必填，上限 1000 字）" },
    noteRequired: { en: "A note is required when rejecting.", zh: "拒絕時必須填寫備註。" },
    readOnly: { en: "Read-only: requires admin or supervisor role.", zh: "唯讀，需管理員或主管角色。" },
  },
  emotion: {
    empty: { en: "No emotion points recorded.", zh: "沒有情緒紀錄。" },
    trigger: { en: "Trigger", zh: "觸發原因" },
    turn: { en: "Turn", zh: "輪次" },
  },
  nextSteps: {
    empty: { en: "No next steps recorded.", zh: "沒有後續行動。" },
    owner: { en: "Owner", zh: "負責角色" },
  },
  replay: {
    unavailable: { en: "No stored replay bundle for this attempt.", zh: "此次評估沒有儲存的重播內容。" },
    hint: { en: "The stored snapshot is what evaluators actually read. It is redacted and immutable.", zh: "此快照即評估器實際讀取的內容，已去識別化且不可修改。" },
    transcript: { en: "Transcript", zh: "對話" },
    canonical: { en: "Canonical Input", zh: "標準輸入" },
    grounding: { en: "Grounding Evidence", zh: "依據證據" },
    retention: { en: "Retained until", zh: "保留至" },
    rawAdminOnly: { en: "Raw evaluator payload is admin-only.", zh: "原始評估器內容僅限管理員。" },
    kbEvidence: { en: "KB evidence", zh: "知識庫證據" },
    policyEvidence: { en: "Policy evidence", zh: "政策證據" },
  },
} as const;
