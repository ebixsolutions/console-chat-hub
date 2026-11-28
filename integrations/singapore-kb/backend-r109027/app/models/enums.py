"""
Authoritative enum registry — 由 39 個 Base44 source .jsonc 完整產生（無截斷）。
schemas/base44_entities/ 為 source of truth；本檔供 repository 寫入時強制驗證，
並供 verify_schema_equivalence.py 逐值比對（enum diff 必須 = 0）。
重新產生：python tests/gen_enums.py
"""
from __future__ import annotations

ENTITY_ENUMS = {
    "CrawledPageResult": {
        "detected_content_type": [
            "FAQ",
            "Product",
            "Policy",
            "About",
            "Other"
        ],
        "crawl_status": [
            "success",
            "failed",
            "skipped",
            "login_required",
            "blocked",
            "empty_content"
        ]
    },
    "FirecrawlConfig": {
        "provider_type": [
            "firecrawl",
            "custom"
        ],
        "test_status": [
            "not_tested",
            "success",
            "failed"
        ]
    },
    "GeneratedTemplateItem": {
        "language": [
            "zh",
            "en"
        ],
        "review_status": [
            "draft",
            "submitted",
            "reviewing",
            "approved",
            "rejected"
        ]
    },
    "IndustryTemplateSkeleton": {
        "industry_key": [
            "fashion_apparel",
            "home_appliance_electronics",
            "food_bakery_grocery",
            "beauty_skincare_wellness",
            "service_booking",
            "general_ecommerce"
        ]
    },
    "KBAgentRegistry": {
        "agent_category": [
            "ContentQuality",
            "RiskCompliance",
            "ConflictVersion",
            "BrandToneIndustry",
            "RAGReadiness",
            "SimulationPublish",
            "Gatekeeper"
        ],
        "agent_type": [
            "industry_agent",
            "multi_agent",
            "system_agent"
        ],
        "default_model_tier": [
            "fast",
            "balanced",
            "reasoning",
            "premium_reasoning"
        ],
        "min_model_tier": [
            "fast",
            "balanced",
            "reasoning",
            "premium_reasoning"
        ],
        "risk_level_routing": [
            "low",
            "medium",
            "high",
            "critical"
        ],
        "credit_priority": [
            "low",
            "normal",
            "high"
        ],
        "agent_usage_scope": [
            "document_review",
            "website_cleaning",
            "routing",
            "ai_training"
        ],
        "credit_cost_estimate": [
            "low",
            "medium",
            "high"
        ]
    },
    "KBAgentResult": {
        "agent_category": [
            "ContentQuality",
            "RiskCompliance",
            "ConflictVersion",
            "BrandToneIndustry",
            "RAGReadiness",
            "SimulationPublish",
            "Gatekeeper"
        ],
        "status": [
            "passed",
            "warning",
            "failed",
            "blocked",
            "skipped"
        ]
    },
    "KBAgentToggleAuditLog": {
        "action": [
            "enabled",
            "disabled",
            "preset_applied"
        ],
        "preset_name": [
            "minimal",
            "standard",
            "full"
        ]
    },
    "KBAuditEvent": {
        "event_type": [
            "publish_requested",
            "detection_completed",
            "detection_partially_skipped",
            "detection_fully_skipped",
            "publish_step_changed",
            "cancel_requested",
            "publish_cancelled",
            "cancellation_failed",
            "publish_completed",
            "publish_failed"
        ]
    },
    "KBCategorySchema": {
        "industry": [
            "ecommerce",
            "retail",
            "healthcare",
            "finance",
            "insurance",
            "food_beverage",
            "beauty_wellness",
            "electronics",
            "logistics",
            "hospitality",
            "education",
            "real_estate",
            "automotive",
            "HomeAppliance",
            "ConsumerElectronics",
            "FoodAndBeverage",
            "OTCMedical",
            "FashionAccessories",
            "HomeLiving",
            "PersonalCareBeauty",
            "HygieneCareProducts",
            "SportsOutdoor",
            "EntertainmentLeisure",
            "OfficeEducation",
            "HomeImprovement",
            "HandmadeCustom"
        ],
        "risk_level": [
            "low",
            "medium",
            "medium_high",
            "high"
        ]
    },
    "KBConfig": {
        "schema_validation_strictness": [
            "strict",
            "standard",
            "relaxed"
        ]
    },
    "KBConflict": {
        "conflict_type": [
            "direct_contradiction",
            "policy_overlap",
            "version_conflict",
            "outdated_info",
            "scope_clash"
        ],
        "severity": [
            "low",
            "medium",
            "high",
            "critical"
        ],
        "status": [
            "open",
            "resolved",
            "ignored"
        ]
    },
    "KBDiffResult": {
        "diff_type": [
            "new",
            "modified",
            "duplicate",
            "deleted"
        ],
        "user_decision": [
            "pending",
            "adopt",
            "skip",
            "override_all",
            "skip_all"
        ],
        "knowledge_type": [
            "faq",
            "policy",
            "product",
            "logistics",
            "compliance",
            "brand_tone",
            "sop",
            "other"
        ]
    },
    "KBDocument": {
        "source_type": [
            "FAQ",
            "Product",
            "TermsAndConditions",
            "Policy",
            "ReturnPolicy",
            "DeliveryPolicy",
            "WarrantyPolicy",
            "InstallationGuide",
            "ServiceSOP",
            "BrandToneGuide",
            "ManualQA",
            "Article",
            "Guide",
            "GlossaryEntry",
            "PaymentPolicy",
            "PrivacyPolicy",
            "Other"
        ],
        "site_type": [
            "ecommerce",
            "service_business",
            "booking_business",
            "information_website",
            "corporate_website",
            "blog_content",
            "help_center",
            "internal_sop"
        ],
        "language": [
            "zh-HK",
            "zh-TW",
            "zh-CN",
            "en",
            "ja",
            "ko"
        ],
        "status": [
            "draft",
            "pending_review",
            "reviewing",
            "approved",
            "published",
            "rejected",
            "archived"
        ],
        "risk_level": [
            "low",
            "medium",
            "medium_high",
            "high"
        ],
        "file_type": [
            "pdf",
            "docx",
            "xlsx",
            "csv",
            "txt",
            "md",
            "html",
            "jpg",
            "png",
            "url",
            "manual"
        ],
        "ocr_status": [
            "not_required",
            "pending",
            "completed",
            "failed"
        ],
        "staging_vector_status": [
            "not_indexed",
            "indexing",
            "indexed",
            "failed"
        ],
        "production_vector_status": [
            "not_indexed",
            "indexing",
            "indexed",
            "failed"
        ],
        "knowledge_type": [
            "faq",
            "policy",
            "benefits",
            "logistics",
            "product",
            "sop",
            "brand_tone",
            "compliance",
            "other"
        ],
        "import_source": [
            "manual_upload",
            "website_import",
            "manual_entry"
        ],
        "import_mode": [
            "single_url",
            "sitemap",
            "selected_pages"
        ],
        "website_cleaning_status": [
            "not_required",
            "pending",
            "rule_cleaned",
            "ai_cleaned",
            "cleaning_skipped",
            "failed"
        ],
        "website_cleaning_confidence": [
            "high",
            "medium",
            "low"
        ],
        "updated_by_app": [
            "kb_manual",
            "ai_training",
            "external_import",
            "system"
        ],
        "training_sync_status": [
            "not_applicable",
            "synced",
            "pending_sync",
            "pending_review",
            "conflict",
            "failed"
        ],
        "production_status": [
            "not_published",
            "staging_tested",
            "production",
            "archived"
        ],
        "conflict_status": [
            "none",
            "detected",
            "resolving",
            "resolved"
        ]
    },
    "KBDocumentVersion": {
        "version_type": [
            "minor",
            "major"
        ],
        "change_type": [
            "initial",
            "content_edit",
            "import_update",
            "ai_adopt",
            "restore",
            "manual_major",
            "ai_training_merge"
        ],
        "changed_by_app": [
            "kb_manual",
            "ai_training",
            "external_import",
            "system"
        ],
        "review_status": [
            "pending",
            "approved",
            "rejected"
        ],
        "vector_status": [
            "not_generated",
            "generating",
            "generated",
            "failed",
            "outdated"
        ]
    },
    "KBGuestImportSession": {
        "purpose": [
            "uat_import"
        ]
    },
    "KBHallucinationEvent": {
        "detected_by": [
            "system",
            "human_review",
            "qa_pipeline"
        ],
        "hallucination_type": [
            "outdated_info",
            "missing_info",
            "wrong_policy",
            "conflicting_sources",
            "fabricated_detail"
        ]
    },
    "KBImportBatch": {
        "source_file_type": [
            "docx",
            "pdf",
            "txt",
            "md",
            "csv",
            "jpg",
            "png",
            "webp",
            "manual",
            "url"
        ],
        "extraction_status": [
            "pending",
            "success",
            "failed"
        ],
        "analysis_status": [
            "pending",
            "completed",
            "failed"
        ],
        "duplicate_check_status": [
            "pending",
            "completed",
            "failed"
        ],
        "review_status": [
            "not_started",
            "reviewing",
            "completed"
        ],
        "rag_status": [
            "not_ready",
            "ready_for_staging",
            "staging_indexed",
            "production_indexed"
        ],
        "status": [
            "uploaded",
            "analyzed",
            "reviewing",
            "confirmed",
            "saved",
            "partially_saved",
            "rolled_back",
            "failed",
            "ready",
            "archived"
        ],
        "extraction_phase": [
            "enumerating",
            "extracting",
            "finalizing",
            "done",
            "failed"
        ],
        "import_source": [
            "manual_upload",
            "manual_entry",
            "website_import"
        ],
        "crawl_mode": [
            "single_url",
            "sitemap",
            "selective"
        ],
        "crawl_status": [
            "not_started",
            "pending",
            "crawling",
            "cleaning",
            "parsed",
            "failed"
        ]
    },
    "KBImportItem": {
        "ai_detected_type": [
            "FAQ",
            "ProductInfo",
            "DeliveryPolicy",
            "ReturnPolicy",
            "PrivacyPolicy",
            "TermsAndConditions",
            "PaymentPolicy",
            "WarrantyPolicy",
            "SizeGuide",
            "ServiceSOP",
            "Other"
        ],
        "source_type": [
            "FAQ",
            "Product",
            "TermsAndConditions",
            "Policy",
            "ReturnPolicy",
            "DeliveryPolicy",
            "WarrantyPolicy",
            "InstallationGuide",
            "ServiceSOP",
            "BrandToneGuide",
            "ManualQA",
            "Article",
            "Guide",
            "GlossaryEntry",
            "PaymentPolicy",
            "PrivacyPolicy",
            "SizeGuide",
            "Other"
        ],
        "knowledge_type": [
            "faq",
            "policy",
            "product",
            "logistics",
            "compliance",
            "brand_tone",
            "sop",
            "other"
        ],
        "risk_level": [
            "low",
            "medium",
            "medium_high",
            "high"
        ],
        "suggested_action": [
            "create_new",
            "update_existing",
            "duplicate",
            "needs_human_review"
        ],
        "duplicate_status": [
            "none",
            "exact_duplicate",
            "semantic_similar",
            "true_conflict",
            "new_content",
            "unclear"
        ],
        "duplicate_action": [
            "pending",
            "overwrite_version",
            "discard_import",
            "keep_as_new",
            "defer"
        ],
        "conflict_type": [
            "none",
            "direct_contradiction",
            "policy_overlap",
            "version_conflict",
            "outdated_info",
            "scope_clash"
        ],
        "human_decision": [
            "pending",
            "ignored",
            "accepted_ai",
            "edited",
            "create_new",
            "update_existing",
            "ignore",
            "accept",
            "edit",
            "auto_skipped"
        ],
        "review_status": [
            "not_started",
            "reviewing",
            "passed",
            "needs_revision",
            "blocked"
        ],
        "status": [
            "pending",
            "reviewing",
            "saved",
            "ignored",
            "failed",
            "enumerated",
            "extracting",
            "needs_manual_check"
        ],
        "issue_type": [
            "section_heading_no_body",
            "marker_not_found",
            "content_misaligned",
            "duplicate_content",
            "original_content_not_found",
            "other"
        ]
    },
    "KBIndustryTemplate": {
        "industry": [
            "ecommerce",
            "retail",
            "healthcare",
            "finance",
            "insurance",
            "food_beverage",
            "beauty_wellness",
            "electronics",
            "logistics",
            "hospitality",
            "education",
            "real_estate",
            "automotive"
        ],
        "source_type": [
            "FAQ",
            "Product",
            "TermsAndConditions",
            "Policy",
            "ReturnPolicy",
            "DeliveryPolicy",
            "WarrantyPolicy",
            "InstallationGuide",
            "ServiceSOP",
            "BrandToneGuide",
            "ManualQA",
            "Other"
        ],
        "priority": [
            "required",
            "recommended",
            "optional"
        ]
    },
    "KBPublishOperation": {
        "status": [
            "preparing",
            "staging",
            "production_writing",
            "activating",
            "completed",
            "cancelling",
            "cancelled",
            "cancellation_failed",
            "failed"
        ],
        "production_writing_status": [
            "none",
            "in_progress",
            "succeeded",
            "failed",
            "timed_out"
        ],
        "rollback_status": [
            "none",
            "pending",
            "in_progress",
            "succeeded",
            "failed",
            "timed_out"
        ],
        "activation_status": [
            "none",
            "in_progress",
            "succeeded",
            "failed",
            "timed_out"
        ]
    },
    "KBReview": {
        "overall_status": [
            "passed",
            "passed_with_warnings",
            "needs_revision",
            "blocked"
        ],
        "publish_decision": [
            "ready",
            "ready_with_review",
            "needs_review",
            "not_ready"
        ],
        "score_confidence": [
            "high",
            "medium",
            "low"
        ]
    },
    "KBReviewFixPreview": {
        "prevalidation_status": [
            "pending",
            "passed",
            "failed",
            "stale",
            "not_applicable"
        ],
        "prevalidation_publish_decision": [
            "ready",
            "ready_with_review",
            "needs_review",
            "not_ready"
        ],
        "formal_publish_decision": [
            "ready",
            "ready_with_review",
            "needs_review",
            "not_ready"
        ],
        "status": [
            "preview",
            "applied",
            "mismatch",
            "failed"
        ]
    },
    "KBSyncLog": {
        "from_app": [
            "knowledge_base",
            "ai_training",
            "live_console",
            "agent_studio",
            "external"
        ],
        "to_app": [
            "knowledge_base",
            "ai_training",
            "live_console",
            "agent_studio",
            "external"
        ],
        "sync_type": [
            "proposal_received",
            "proposal_reviewed",
            "proposal_approved",
            "proposal_rejected",
            "proposal_merged",
            "version_created_from_proposal",
            "version_published",
            "version_synced",
            "conflict_detected",
            "conflict_resolved",
            "manual_sync",
            "restore_from_ai_training_update"
        ],
        "sync_direction": [
            "inbound",
            "outbound"
        ],
        "sync_status": [
            "pending",
            "in_progress",
            "completed",
            "failed",
            "conflict"
        ],
        "conflict_status": [
            "none",
            "detected",
            "resolving",
            "resolved"
        ]
    },
    "KBUserPublishConfirmation": {
        "approval_mode": [
            "user_confirmation"
        ],
        "publish_result": [
            "pending",
            "success",
            "partial",
            "failed"
        ]
    },
    "KBVectorChunk": {
        "chunk_type": [
            "full_content",
            "rag_summary",
            "faq_pair",
            "section"
        ],
        "embedding_status": [
            "pending",
            "generating",
            "generated",
            "failed"
        ],
        "vector_store": [
            "base44_placeholder",
            "local_embedding",
            "pinecone",
            "pgvector",
            "weaviate",
            "vertex_matching_engine"
        ],
        "environment": [
            "staging",
            "production"
        ],
        "status": [
            "active",
            "superseded",
            "archived",
            "failed"
        ]
    },
    "PlatformLLMCreditBudget": {
        "scope_type": [
            "global",
            "app",
            "module",
            "provider",
            "task_type",
            "agent",
            "user",
            "model_tier"
        ]
    },
    "PlatformLLMModelOption": {
        "model_tier": [
            "fast",
            "balanced",
            "reasoning",
            "premium_reasoning"
        ],
        "cost_level": [
            "low",
            "medium",
            "high"
        ],
        "reasoning_strength": [
            "basic",
            "medium",
            "strong"
        ]
    },
    "PlatformLLMProviderConfig": {
        "provider_type": [
            "openai",
            "gemini",
            "vertex_ai_gemini",
            "deepseek",
            "custom"
        ],
        "default_model_tier": [
            "fast",
            "reasoning"
        ],
        "test_status": [
            "not_tested",
            "success",
            "failed"
        ]
    },
    "PlatformLLMRequestLog": {
        "app_key": [
            "knowledge_base",
            "ai_training",
            "live_console",
            "agent_studio",
            "other"
        ],
        "source_object_type": [
            "kb_document",
            "template_generation_job",
            "training_case",
            "live_conversation",
            "other"
        ],
        "model_tier": [
            "fast",
            "reasoning"
        ],
        "status": [
            "success",
            "failed",
            "timeout"
        ],
        "error_code": [
            "invalid_key",
            "permission_denied",
            "model_not_found",
            "quota_exceeded",
            "timeout",
            "network_error",
            "unknown"
        ]
    },
    "PlatformLLMRoutingDecisionLog": {
        "content_risk_level": [
            "low",
            "medium",
            "high",
            "critical"
        ],
        "content_complexity_level": [
            "simple",
            "normal",
            "complex"
        ],
        "credit_budget_status": [
            "normal",
            "warning",
            "hard_stop"
        ]
    },
    "PlatformLLMRoutingPolicy": {
        "app_key": [
            "knowledge_base",
            "ai_training",
            "live_console",
            "agent_studio",
            "template_generator",
            "any"
        ],
        "task_type": [
            "classification",
            "metadata_extraction",
            "template_generation",
            "completeness_review",
            "correctness_review",
            "readability_review",
            "contradiction_detection",
            "compliance_review",
            "hallucination_check",
            "risk_assessment",
            "tone_review",
            "localization_review",
            "rag_answer",
            "answer_simulation",
            "publish_gatekeeper",
            "agent_test",
            "training_evaluation",
            "live_reply",
            "other"
        ],
        "default_model_tier": [
            "fast",
            "balanced",
            "reasoning",
            "premium_reasoning"
        ],
        "min_model_tier": [
            "fast",
            "balanced",
            "reasoning",
            "premium_reasoning"
        ],
        "max_model_tier": [
            "fast",
            "balanced",
            "reasoning",
            "premium_reasoning"
        ]
    },
    "TemplateGenerationJob": {
        "market_region": [
            "hong_kong",
            "taiwan",
            "macau",
            "singapore",
            "united_states",
            "general"
        ],
        "status": [
            "pending",
            "generating",
            "completed",
            "failed"
        ],
        "language": [
            "zh",
            "en"
        ]
    },
    "TrainingKnowledgeProposal": {
        "source_app": [
            "ai_training",
            "live_console",
            "agent_studio",
            "external"
        ],
        "severity": [
            "p0_critical",
            "p1_high",
            "p2_medium",
            "p3_low"
        ],
        "status": [
            "received",
            "validating",
            "auto_ingested",
            "indexed",
            "failed",
            "conflict",
            "unmatched"
        ],
        "conflict_status": [
            "none",
            "detected",
            "resolving",
            "resolved"
        ],
        "training_status": [
            "passed",
            "failed"
        ],
        "failure_type": [
            "training_not_passed",
            "score_below_threshold",
            "not_approved_by_training",
            "ingest_error",
            "rag_error",
            "vector_error"
        ]
    },
    "User": {
        "role": [
            "admin",
            "user"
        ]
    },
    "WebsiteContentCleaningRule": {
        "rule_type": [
            "keyword_blacklist",
            "regex_pattern",
            "line_pattern"
        ],
        "apply_to": [
            "all_websites",
            "ecommerce",
            "other"
        ]
    },
    "WebsiteImportJob": {
        "import_mode": [
            "single_url",
            "sitemap",
            "selected_pages"
        ],
        "status": [
            "pending",
            "validating",
            "crawling",
            "processing",
            "completed",
            "partial_success",
            "failed"
        ]
    },
    "WebsiteImportLog": {
        "status": [
            "success",
            "warning",
            "error"
        ]
    }
}


def allowed(entity: str, field: str):
    return ENTITY_ENUMS.get(entity, {}).get(field)
