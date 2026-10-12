"""
內容型態對照（source_type → knowledge_type）

欄位說明：
  - label           顯示名稱（供 UI 下拉）
  - source_type     來源型態（寫入 kb_import_item.source_type）
  - knowledge_type  知識型態（寫入 kb_import_item.knowledge_type）

區分一般政策 / 私隱政策：
  - 一般政策（policy）   → source_type = "Policy"
  - 私隱政策（compliance） → source_type = "PrivacyPolicy"（獨立值，無歧義）

   若維持兩者皆為 "Policy"，API 僅依 source_type 查詢將無法分辨。故私隱政策
   使用獨立 source_type，並與 import_pipeline.SOURCE_TYPE_TO_KNOWLEDGE_TYPE
   （PrivacyPolicy → compliance）一致。
"""
from __future__ import annotations

CONTENT_TYPES: list[dict[str, str]] = [
    {"label": "常見問題 FAQ", "source_type": "FAQ", "knowledge_type": "faq"},
    {"label": "產品資料", "source_type": "Product", "knowledge_type": "product"},
    {"label": "一般政策", "source_type": "Policy", "knowledge_type": "policy"},
    {"label": "退貨政策", "source_type": "ReturnPolicy", "knowledge_type": "policy"},
    {"label": "送貨政策", "source_type": "DeliveryPolicy", "knowledge_type": "logistics"},
    {"label": "保固政策", "source_type": "WarrantyPolicy", "knowledge_type": "policy"},
    {"label": "私隱政策", "source_type": "PrivacyPolicy", "knowledge_type": "compliance"},
    {"label": "條款及細則", "source_type": "TermsAndConditions", "knowledge_type": "compliance"},
    {"label": "安裝指南", "source_type": "InstallationGuide", "knowledge_type": "sop"},
    {"label": "服務流程 SOP", "source_type": "ServiceSOP", "knowledge_type": "sop"},
    {"label": "品牌語氣指南", "source_type": "BrandToneGuide", "knowledge_type": "brand_tone"},
    {"label": "文章", "source_type": "Article", "knowledge_type": "other"},
    {"label": "指南", "source_type": "Guide", "knowledge_type": "other"},
    {"label": "詞彙解釋", "source_type": "GlossaryEntry", "knowledge_type": "other"},
    {"label": "其他", "source_type": "Other", "knowledge_type": "other"},
]

DEFAULT_KNOWLEDGE_TYPE = "other"

# source_type → knowledge_type（source_type 唯一，無歧義）
_SOURCE_TYPE_MAP: dict[str, str] = {
    _ct["source_type"].strip(): _ct["knowledge_type"]
    for _ct in CONTENT_TYPES
}


def knowledge_type_for(source_type: str,
                       default: str = DEFAULT_KNOWLEDGE_TYPE) -> str:
    """依 source_type 查 knowledge_type；查無（或空白）回 default。"""
    return _SOURCE_TYPE_MAP.get((source_type or "").strip(), default)


def label_for_source_type(source_type: str) -> str:
    """回傳 source_type 對應的第一筆 label；查無回空字串。"""
    st = (source_type or "").strip()
    for _ct in CONTENT_TYPES:
        if _ct["source_type"] == st:
            return _ct["label"]
    return ""