export * from "./prior-grounded-transform-core.ts";

import {
  type PriorGroundedTransformContext,
  resolvePriorGroundedTransform as resolvePriorGroundedTransformCore,
} from "./prior-grounded-transform-core.ts";
import type { SemanticHistoryRow } from "./conversation-semantic-contract.ts";

const CURRENT_STATE_SUMMARY_VERB =
  /(?:總結|总结|整理|列出|概括|歸納|归纳|summari[sz]e|list)/i;
const CURRENT_STATE_SUMMARY_SCOPE =
  /(?:(?:根據|根据|按|依照|基於|基于|based\s+on|according\s+to).{0,80}(?:我|my).{0,50}(?:最新|目前|現時|現在|现在|而家|依家|current|latest).{0,50}(?:提供|資料|资料|資訊|信息|details|information)|(?:我|my).{0,40}(?:最新|目前|現時|現在|现在|而家|依家|current|latest).{0,40}(?:提供|資料|资料|資訊|信息|details|information|需求|要求|requirements?))/i;
const CURRENT_STATE_FIELDS =
  /(?:商品|產品|产品|sku|staff|員工|员工|人手|市場|市场|market|app|push|crm|會員等級|会员等级|功能|features?)/i;
const EXPLICIT_CURRENT_REQUIREMENTS_SUMMARY =
  /(?:總結|总结|整理|列出|概括|歸納|归纳|summari[sz]e|list).{0,30}(?:我|my)?\s*.{0,12}(?:最新|目前|現時|現在|现在|而家|依家|current|latest).{0,20}(?:條件|条件|需求|要求|requirements?)/i;

function isCurrentCustomerStateSummary(text: string): boolean {
  const latest = typeof text === "string"
    ? text.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 1600)
    : "";
  if (!latest || !CURRENT_STATE_SUMMARY_VERB.test(latest)) return false;

  // Explicit latest/current requirement-summary requests are conversation-memory
  // operations even when the current turn does not repeat individual state fields.
  if (EXPLICIT_CURRENT_REQUIREMENTS_SUMMARY.test(latest)) return true;

  return Boolean(
    CURRENT_STATE_SUMMARY_SCOPE.test(latest) &&
      CURRENT_STATE_FIELDS.test(latest),
  );
}

export function resolvePriorGroundedTransform(
  latest: string,
  newestFirst: SemanticHistoryRow[],
): PriorGroundedTransformContext | null {
  if (isCurrentCustomerStateSummary(latest)) return null;
  return resolvePriorGroundedTransformCore(latest, newestFirst);
}
