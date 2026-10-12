"""
Nexus KB — 全部 39 個 production data model
由 Base44 entity schema (2026-08-04 live) 自動產生並人工校正
排除 19 個 noop 佔位 entity（見 EXCLUDED_NOOP_ENTITIES）
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from sqlalchemy import (Column, String, Integer, Numeric, Boolean, JSON,
                        DateTime, Text, Index)
from sqlalchemy.dialects.postgresql import JSONB as _PG_JSONB
JSONB = _PG_JSONB().with_variant(JSON(), "sqlite")
from sqlalchemy.orm import declarative_base

Base = declarative_base()


def gen_id() -> str:
    return uuid.uuid4().hex


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class TimestampMixin:
    created_date = Column(DateTime(timezone=True), default=_utcnow)
    updated_date = Column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)


class OwnershipMixin:
    created_by = Column(String)      # user id / email（Base44 ownership）
    tenant_id = Column(String)       # 租戶隔離（= created_by 或組織 id）


class CrawledPageResult(Base, TimestampMixin, OwnershipMixin):
    """CrawledPageResult"""
    __tablename__ = "kb_crawled_page_result"
    id = Column(String, primary_key=True, default=gen_id)
    job_id = Column(String, nullable=False)
    source_url = Column(String, nullable=False)
    page_title = Column(String)
    detected_content_type = Column(Text, default="Other")  # enum: FAQ, Product, Policy, About, Other
    extracted_markdown = Column(String)
    extracted_text = Column(Text)
    language = Column(String, default="zh-TW")
    word_count = Column(Numeric, default=0)
    http_status = Column(Numeric, default=200)
    crawl_status = Column(Text, default="success")  # enum: success, failed, skipped, login_required, blocked, empty_content
    error_message = Column(Text)
    kb_document_id = Column(String)
    company_id = Column(Numeric)


class FirecrawlConfig(Base, TimestampMixin, OwnershipMixin):
    """FirecrawlConfig"""
    __tablename__ = "kb_firecrawl_config"
    id = Column(String, primary_key=True, default=gen_id)
    provider_name = Column(String, default="Firecrawl", nullable=False)
    provider_type = Column(String, default="firecrawl")  # enum: firecrawl, custom
    api_base_url = Column(String, default="https://api.firecrawl.dev")
    api_key = Column(String)
    api_key_masked = Column(String)
    api_key_last4 = Column(String)
    max_pages_per_job = Column(Numeric, default=50)
    timeout_seconds = Column(Numeric, default=60)
    wait_for_ms = Column(Numeric, default=5000)
    is_active = Column(Boolean, default=True)
    last_tested_at = Column(DateTime(timezone=True))
    test_status = Column(String, default="not_tested")  # enum: not_tested, success, failed
    company_id = Column(Numeric)


class GeneratedTemplateItem(Base, TimestampMixin, OwnershipMixin):
    """GeneratedTemplateItem"""
    __tablename__ = "kb_generated_template_item"
    id = Column(String, primary_key=True, default=gen_id)
    job_id = Column(String, nullable=False)
    industry_key = Column(String)
    item_key = Column(String, nullable=False)
    document_type = Column(String)
    title = Column(String, nullable=False)
    original_generated_content = Column(Text)
    edited_content = Column(Text)
    approved_content = Column(Text)
    template_version = Column(String, default="1.0")
    generated_by = Column(String)
    language = Column(String, default="zh")  # enum: zh, en
    is_required = Column(Boolean, default=False)
    is_deleted = Column(Boolean, default=False)
    edit_count = Column(Numeric, default=0)
    regenerate_count = Column(Numeric, default=0)
    review_status = Column(String, default="draft")  # enum: draft, submitted, reviewing, approved, rejected
    sort_order = Column(Numeric, default=0)
    company_id = Column(Numeric)


class IndustryTemplateSkeleton(Base, TimestampMixin, OwnershipMixin):
    """IndustryTemplateSkeleton"""
    __tablename__ = "kb_industry_template_skeleton"
    id = Column(String, primary_key=True, default=gen_id)
    industry_key = Column(String, nullable=False)  # enum: fashion_apparel, home_appliance_electronics, food_bakery_grocery, beauty_skincare_wellness, service_booking, general_ecommerce
    industry_label_zh = Column(String, nullable=False)
    industry_label_en = Column(String, nullable=False)
    industry_icon = Column(String)
    template_items = Column(JSONB)
    ai_prompt_hint = Column(Text)
    is_active = Column(Boolean, default=True)
    version = Column(String, default="1.0")
    company_id = Column(Numeric)


class KBAgentRegistry(Base, TimestampMixin, OwnershipMixin):
    """KBAgentRegistry"""
    __tablename__ = "kb_agent_registry"
    id = Column(String, primary_key=True, default=gen_id)
    agent_key = Column(String, nullable=False)
    agent_name = Column(String, nullable=False)
    layer = Column(Numeric)
    agent_category = Column(String)  # enum: ContentQuality, RiskCompliance, ConflictVersion, BrandToneIndustry, RAGReadiness, SimulationPublish, Gatekeeper
    agent_type = Column(String)  # enum: industry_agent, multi_agent, system_agent
    description = Column(Text)
    weight = Column(Numeric)
    is_active = Column(Boolean, default=True)
    default_model_tier = Column(String, default="fast")  # enum: fast, balanced, reasoning, premium_reasoning
    min_model_tier = Column(String, default="fast")  # enum: fast, balanced, reasoning, premium_reasoning
    preferred_provider_type = Column(String, default="any")
    requires_reasoning = Column(Boolean, default=False)
    risk_level_routing = Column(String, default="medium")  # enum: low, medium, high, critical
    credit_priority = Column(String, default="normal")  # enum: low, normal, high
    routing_notes = Column(Text)
    agent_usage_scope = Column(String, default="document_review")  # enum: document_review, website_cleaning, routing, ai_training
    include_in_review_score = Column(Boolean, default=True)
    can_be_disabled = Column(Boolean, default=True)
    disable_reason_required = Column(Boolean, default=False)
    required_for_publish = Column(Boolean, default=False)
    required_for_rag_indexing = Column(Boolean, default=False)
    agent_description_zh = Column(Text)
    agent_description_en = Column(Text)
    credit_cost_estimate = Column(String, default="low")  # enum: low, medium, high
    credit_cost_weight = Column(Numeric, default=1)
    company_id = Column(Numeric)


class KBAgentResult(Base, TimestampMixin, OwnershipMixin):
    """KBAgentResult"""
    __tablename__ = "kb_agent_result"
    id = Column(String, primary_key=True, default=gen_id)
    review_id = Column(String, nullable=False)
    layer = Column(Numeric)
    agent_name = Column(String)
    agent_key = Column(String, nullable=False)
    agent_category = Column(String)  # enum: ContentQuality, RiskCompliance, ConflictVersion, BrandToneIndustry, RAGReadiness, SimulationPublish, Gatekeeper
    score = Column(Numeric)
    status = Column(String, default="passed")  # enum: passed, warning, failed, blocked, skipped
    issue_summary = Column(Text)
    recommendation = Column(String)
    fix_suggestion = Column(String)
    is_blocking = Column(Boolean, default=False)
    affected_sections = Column(JSONB)
    source_references = Column(JSONB)
    skipped_reason = Column(Text)
    skipped_by_toggle_config_id = Column(String)
    contributes_to_score = Column(Boolean, default=True)
    company_id = Column(Numeric)


class KBAgentToggleAuditLog(Base, TimestampMixin, OwnershipMixin):
    """KBAgentToggleAuditLog"""
    __tablename__ = "kb_agent_toggle_audit_log"
    id = Column(String, primary_key=True, default=gen_id)
    agent_key = Column(String, nullable=False)
    action = Column(String, nullable=False)  # enum: enabled, disabled, preset_applied
    old_value = Column(Boolean)
    new_value = Column(Boolean)
    preset_name = Column(String)  # enum: minimal, standard, full
    apply_to_source_types = Column(JSONB)
    reason = Column(Text)
    changed_by = Column(String, nullable=False)
    changed_at = Column(DateTime(timezone=True), nullable=False)
    company_id = Column(Numeric)


class KBAgentToggleConfig(Base, TimestampMixin, OwnershipMixin):
    """KBAgentToggleConfig"""
    __tablename__ = "kb_agent_toggle_config"
    id = Column(String, primary_key=True, default=gen_id)
    agent_key = Column(String, nullable=False)
    is_enabled = Column(Boolean, default=True)
    disabled_reason = Column(Text)
    disabled_by = Column(String)
    disabled_at = Column(DateTime(timezone=True))
    apply_to_source_types = Column(JSONB, default=dict)
    apply_to_document_categories = Column(JSONB, default=dict)
    updated_by = Column(String)
    updated_at = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class KBAuditEvent(Base, TimestampMixin, OwnershipMixin):
    """KBAuditEvent"""
    __tablename__ = "kb_audit_event"
    id = Column(String, primary_key=True, default=gen_id)
    operation_id = Column(String, nullable=False)
    user_id = Column(String, nullable=False)
    event_type = Column(String, nullable=False)  # enum: publish_requested, detection_completed, detection_partially_skipped, detection_fully_skipped, publish_step_changed, cancel_requested, publish_cancelled, cancellation_failed...
    document_ids = Column(JSONB)
    document_versions = Column(JSONB)
    document_hashes = Column(JSONB)
    skipped_detection_types = Column(JSONB)
    idempotency_key = Column(String)
    previous_status = Column(String)
    new_status = Column(String)
    payload = Column(JSONB)
    created_at = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class KBCategorySchema(Base, TimestampMixin, OwnershipMixin):
    """KBCategorySchema"""
    __tablename__ = "kb_category_schema"
    id = Column(String, primary_key=True, default=gen_id)
    industry = Column(String)  # enum: ecommerce, retail, healthcare, finance, insurance, food_beverage, beauty_wellness, electronics...
    category_name = Column(String, nullable=False)
    required_fields = Column(JSONB)
    optional_fields = Column(JSONB)
    validation_rules = Column(JSONB)
    allowed_values = Column(JSONB)
    risk_level = Column(String, default="medium")  # enum: low, medium, medium_high, high
    risk_override_tags = Column(JSONB)
    json_template = Column(String)
    html_template = Column(String)
    is_active = Column(Boolean, default=True)
    company_id = Column(Numeric)


class KBConfig(Base, TimestampMixin, OwnershipMixin):
    """KBConfig"""
    __tablename__ = "kb_config"
    id = Column(String, primary_key=True, default=gen_id)
    config_id = Column(String, default="singleton", nullable=False)
    layer1_enabled = Column(Boolean, default=True)
    layer2_enabled = Column(Boolean, default=True)
    layer3_enabled = Column(Boolean, default=True)
    layer4_enabled = Column(Boolean, default=True)
    layer5_enabled = Column(Boolean, default=True)
    layer6_enabled = Column(Boolean, default=True)
    layer7_enabled = Column(Boolean, default=True)
    min_publish_score = Column(Numeric, default=70)
    min_rag_readiness_score = Column(Numeric, default=75)
    min_auto_ingest_score = Column(Numeric, default=70)
    require_human_for_high_risk = Column(Boolean, default=True)
    agent_timeout_seconds = Column(Numeric, default=30)
    default_industry = Column(String, default="HomeAppliance")
    default_site_type = Column(String, default="ecommerce")
    auto_detect_industry = Column(Boolean, default=True)
    schema_validation_strictness = Column(String, default="standard")  # enum: strict, standard, relaxed
    auto_index_staging_on_import = Column(Boolean, default=False)
    auto_index_staging_on_review_pass = Column(Boolean, default=False)
    auto_index_production_on_pub = Column(Boolean, default=True)
    chunk_size_tokens = Column(Numeric, default=512)
    chunk_overlap_tokens = Column(Numeric, default=50)
    notify_review_complete = Column(Boolean, default=True)
    notify_blocking_issue = Column(Boolean, default=True)
    notify_conflict_detected = Column(Boolean, default=True)
    notify_published = Column(Boolean, default=True)
    notify_channel_in_app = Column(Boolean, default=True)
    notify_channel_email = Column(Boolean, default=False)
    website_ai_cleaning_enabled = Column(Boolean, default=False)
    company_id = Column(Numeric)


class KBConflict(Base, TimestampMixin, OwnershipMixin):
    """KBConflict"""
    __tablename__ = "kb_conflict"
    id = Column(String, primary_key=True, default=gen_id)
    document_id_a = Column(String, nullable=False)
    document_id_b = Column(String)
    conflict_type = Column(String, default="direct_contradiction", nullable=False)  # enum: direct_contradiction, policy_overlap, version_conflict, outdated_info, scope_clash
    severity = Column(String, default="medium")  # enum: low, medium, high, critical
    description = Column(Text)
    status = Column(String, default="open")  # enum: open, resolved, ignored
    resolution_note = Column(String)
    detected_at = Column(DateTime(timezone=True))
    resolved_at = Column(DateTime(timezone=True))
    ai_suggestion = Column(String)
    company_id = Column(Numeric)


class KBDiffResult(Base, TimestampMixin, OwnershipMixin):
    """KBDiffResult"""
    __tablename__ = "kb_diff_result"
    id = Column(String, primary_key=True, default=gen_id)
    session_id = Column(String, nullable=False)
    document_id = Column(String)
    file_name = Column(String, nullable=False)
    diff_type = Column(String, nullable=False)  # enum: new, modified, duplicate, deleted
    category = Column(String)
    item_title = Column(String)
    field_changed = Column(String)
    old_value = Column(String)
    new_value = Column(String)
    diff_detail = Column(Text)
    old_document_version = Column(String)
    new_document_version = Column(String)
    user_decision = Column(String, default="pending")  # enum: pending, adopt, skip, override_all, skip_all
    decided_at = Column(DateTime(timezone=True))
    decided_by = Column(String)
    ai_confidence = Column(Numeric)
    knowledge_type = Column(String)  # enum: faq, policy, product, logistics, compliance, brand_tone, sop, other
    company_id = Column(Numeric)


class KBDocument(Base, TimestampMixin, OwnershipMixin):
    """KBDocument"""
    __tablename__ = "kb_document"
    id = Column(String, primary_key=True, default=gen_id)
    name = Column(String, nullable=False)
    source_type = Column(String, default="FAQ")  # enum: FAQ, Product, TermsAndConditions, Policy, ReturnPolicy, DeliveryPolicy, WarrantyPolicy, InstallationGuide...
    industry = Column(String, default="HomeAppliance")  # free-form industry value (no enum restriction)
    industries = Column(JSONB, default=dict)
    sub_industries = Column(JSONB, default=list)  # string array, e.g. ["HomeAppliance_AirCon"]
    site_type = Column(String, default="ecommerce")  # enum: ecommerce, service_business, booking_business, information_website, corporate_website, blog_content, help_center, internal_sop
    category = Column(String)
    language = Column(String, default="zh-TW")  # enum: zh-HK, zh-TW, zh-CN, en, ja, ko
    status = Column(String, default="draft")  # enum: draft, pending_review, reviewing, approved, published, rejected, archived
    version = Column(String, default="1.0")
    effective_date = Column(DateTime(timezone=True))
    expiry_date = Column(DateTime(timezone=True))
    risk_level = Column(String, default="medium")  # enum: low, medium, medium_high, high
    file_url = Column(String)
    file_type = Column(String, default="manual")  # enum: pdf, docx, xlsx, csv, txt, md, html, jpg...
    raw_content = Column(Text)
    parsed_chunks = Column(JSONB)
    ai_detected_source_type = Column(String)
    ai_detected_industry = Column(String)
    ai_detected_category = Column(String)
    ai_detection_confidence = Column(Numeric)
    is_mixed_content = Column(Boolean, default=False)
    ocr_status = Column(String, default="not_required")  # enum: not_required, pending, completed, failed
    field_mapping = Column(JSONB)
    staging_vector_status = Column(String, default="not_indexed")  # enum: not_indexed, indexing, indexed, failed
    production_vector_status = Column(String, default="not_indexed")  # enum: not_indexed, indexing, indexed, failed
    available_to_live_console = Column(Boolean, default=False)
    published_at = Column(DateTime(timezone=True))
    used_by_agents = Column(JSONB)
    helpfulness_score = Column(Numeric, default=0)
    retrieval_count = Column(Numeric, default=0)
    hallucination_count = Column(Numeric, default=0)
    citation_accuracy = Column(Numeric, default=0)
    is_outdated = Column(Boolean, default=False)
    outdated_since_days = Column(Numeric, default=0)
    vector_count = Column(Numeric, default=0)
    chunk_count = Column(Numeric, default=0)
    last_synced_at = Column(DateTime(timezone=True))
    synced_to_helpdesk = Column(Boolean, default=False)
    synced_to_training = Column(Boolean, default=False)
    knowledge_type = Column(String, default="faq")  # enum: faq, policy, benefits, logistics, product, sop, brand_tone, compliance...
    summary = Column(Text)
    tags = Column(JSONB)
    related_agent_ids = Column(JSONB)
    quality_score = Column(Numeric, default=0)
    rag_readiness_score = Column(Numeric, default=0)
    import_source = Column(String, default="manual_upload")  # enum: manual_upload, website_import, manual_entry
    source_url = Column(String)
    source_domain = Column(String)
    crawler_job_id = Column(Text)
    page_title = Column(String)
    import_mode = Column(String)  # enum: single_url, sitemap, selected_pages
    website_cleaning_status = Column(String)  # enum: not_required, pending, rule_cleaned, ai_cleaned, cleaning_skipped, failed
    website_cleaning_log = Column(String)
    website_cleaning_confidence = Column(String)  # enum: high, medium, low
    website_raw_markdown = Column(Text)
    website_raw_markdown_truncated = Column(Boolean, default=False)
    skipped_agents = Column(JSONB)
    partial_review_warning = Column(Boolean, default=False)
    high_risk_review_incomplete = Column(Boolean, default=False)
    global_document_id = Column(String)
    app_document_id = Column(String)
    content_hash = Column(Text)
    rag_summary = Column(Text)
    rag_summary_hash = Column(Text)
    updated_by_app = Column(String, default="kb_manual")  # enum: kb_manual, ai_training, external_import, system
    training_sync_status = Column(String, default="not_applicable")  # enum: not_applicable, synced, pending_sync, pending_review, conflict, failed
    last_sync_at = Column(DateTime(timezone=True))
    production_status = Column(String, default="not_published")  # enum: not_published, staging_tested, production, archived
    active_version_id = Column(String)
    latest_training_proposal_id = Column(String)
    conflict_status = Column(String, default="none")  # enum: none, detected, resolving, resolved
    ai_suggested_content = Column(Text)
    ai_suggestion_score = Column(Numeric, default=0)
    ai_suggestion_generated_at = Column(DateTime(timezone=True))
    staging_indexed_content_hash = Column(Text)
    archived_by = Column(String)
    archived_at = Column(DateTime(timezone=True))
    archive_reason = Column(Text)
    restored_by = Column(String)
    restored_at = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class KBDocumentVersion(Base, TimestampMixin, OwnershipMixin):
    """KBDocumentVersion"""
    __tablename__ = "kb_document_version"
    id = Column(String, primary_key=True, default=gen_id)
    document_id = Column(String, nullable=False)
    version = Column(String, nullable=False)
    version_type = Column(String, default="minor")  # enum: minor, major
    change_type = Column(String, default="content_edit")  # enum: initial, content_edit, import_update, ai_adopt, restore, manual_major, ai_training_merge
    change_summary = Column(Text)
    items_added = Column(Numeric, default=0)
    items_modified = Column(Numeric, default=0)
    items_deleted = Column(Numeric, default=0)
    raw_content_snapshot = Column(Text)
    snapshot_reason = Column(Text)
    content_hash = Column(Text)
    rag_summary = Column(Text)
    rag_summary_hash = Column(Text)
    changed_by_app = Column(String, default="kb_manual")  # enum: kb_manual, ai_training, external_import, system
    related_training_case_id = Column(String)
    related_training_proposal_id = Column(String)
    review_status = Column(String, default="pending")  # enum: pending, approved, rejected
    vector_status = Column(String, default="not_generated")  # enum: not_generated, generating, generated, failed, outdated
    company_id = Column(Numeric)


class KBGuestImportSession(Base, TimestampMixin, OwnershipMixin):
    """KBGuestImportSession"""
    __tablename__ = "kb_guest_import_session"
    id = Column(String, primary_key=True, default=gen_id)
    session_id = Column(String, nullable=False)
    batch_id = Column(String, nullable=False)
    purpose = Column(String, default="uat_import")  # enum: uat_import
    created_at = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class KBGuestUATProbe(Base, TimestampMixin, OwnershipMixin):
    """KBGuestUATProbe"""
    __tablename__ = "kb_guest_uat_probe"
    id = Column(String, primary_key=True, default=gen_id)
    session_id = Column(String, nullable=False)
    stage = Column(String, nullable=False)
    message = Column(Text)
    created_at = Column(DateTime(timezone=True))


class KBHallucinationEvent(Base, TimestampMixin, OwnershipMixin):
    """KBHallucinationEvent"""
    __tablename__ = "kb_hallucination_event"
    id = Column(String, primary_key=True, default=gen_id)
    ai_response_snippet = Column(String)
    conflicting_source = Column(String)
    conversation_id = Column(String)
    detected_at = Column(DateTime(timezone=True))
    detected_by = Column(String, default="system")  # enum: system, human_review, qa_pipeline
    document_id = Column(String, nullable=False)
    document_name = Column(String)
    hallucination_type = Column(String, nullable=False)  # enum: outdated_info, missing_info, wrong_policy, conflicting_sources, fabricated_detail
    is_resolved = Column(Boolean, default=False)
    resolution_action = Column(String)
    resolved_at = Column(DateTime(timezone=True))
    risk_score = Column(Numeric)
    root_cause = Column(String)
    user_query = Column(String)
    company_id = Column(Numeric)



class KBImportBatch(Base, TimestampMixin, OwnershipMixin):
    """KBImportBatch"""
    __tablename__ = "kb_import_batch"
    id = Column(String, primary_key=True, default=gen_id)
    batch_name = Column(String, nullable=False)
    source_file_name = Column(String)
    source_file_type = Column(String)  # enum: docx, pdf, txt, md, csv, jpg, png, webp...
    original_document_id = Column(String)
    raw_content = Column(Text)
    extraction_status = Column(String, default="pending")  # enum: pending, success, failed
    analysis_status = Column(String, default="pending")  # enum: pending, completed, failed
    duplicate_check_status = Column(String, default="pending")  # enum: pending, completed, failed
    review_status = Column(String, default="not_started")  # enum: not_started, reviewing, completed
    rag_status = Column(String, default="not_ready")  # enum: not_ready, ready_for_staging, staging_indexed, production_indexed
    extraction_error = Column(Text)
    is_mixed_content = Column(Boolean, default=False)
    detected_sections = Column(JSONB)
    total_items = Column(Numeric, default=0)
    faq_count = Column(Numeric, default=0)
    product_count = Column(Numeric, default=0)
    delivery_policy_count = Column(Numeric, default=0)
    return_policy_count = Column(Numeric, default=0)
    privacy_policy_count = Column(Numeric, default=0)
    terms_count = Column(Numeric, default=0)
    payment_policy_count = Column(Numeric, default=0)
    policy_count = Column(Numeric, default=0)
    duplicate_count = Column(Numeric, default=0)
    update_count = Column(Numeric, default=0)
    new_count = Column(Numeric, default=0)
    needs_review_count = Column(Numeric, default=0)
    overall_readiness_score = Column(Numeric, default=0)
    site_type = Column(String)
    status = Column(String, default="uploaded")  # enum: uploaded, analyzed, reviewing, confirmed, saved, partially_saved, rolled_back, failed...
    saved_doc_ids = Column(JSONB)
    extraction_phase = Column(String)  # enum: enumerating, extracting, finalizing, done, failed
    items_extracted = Column(Numeric, default=0)
    items_failed = Column(Numeric, default=0)
    partial = Column(Boolean, default=False)
    source_encoding = Column(String)
    import_source = Column(String, default="manual_upload")  # enum: manual_upload, manual_entry, website_import
    source_url = Column(String)
    source_domain = Column(String)
    crawl_mode = Column(Text)  # enum: single_url, sitemap, selective
    crawler_job_id = Column(Text)
    crawl_status = Column(Text, default="not_started")  # enum: not_started, pending, crawling, cleaning, parsed, failed
    crawl_failure_reason = Column(Text)
    pages_found = Column(Numeric, default=0)
    pages_crawled = Column(Numeric, default=0)
    crawl_pages_preview = Column(JSONB)
    archived_by = Column(String)
    archived_at = Column(DateTime(timezone=True))
    archive_reason = Column(Text)
    restored_by = Column(String)
    restored_at = Column(DateTime(timezone=True))
    pending_industry_review = Column(Boolean, default=False)
    pending_industry_review_set_at = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class KBImportItem(Base, TimestampMixin, OwnershipMixin):
    """KBImportItem"""
    __tablename__ = "kb_import_item"
    id = Column(String, primary_key=True, default=gen_id)
    batch_id = Column(String, nullable=False)
    original_document_id = Column(String)
    item_index = Column(Numeric)
    original_section_title = Column(String)
    extracted_title = Column(String, nullable=False)
    original_content = Column(Text)
    ai_suggested_content = Column(Text)
    human_edited_content = Column(Text)
    final_content = Column(Text)
    ai_detected_type = Column(String)  # enum: FAQ, ProductInfo, DeliveryPolicy, ReturnPolicy, PrivacyPolicy, TermsAndConditions, PaymentPolicy, WarrantyPolicy...
    source_type = Column(String)  # enum: FAQ, Product, TermsAndConditions, Policy, ReturnPolicy, DeliveryPolicy, WarrantyPolicy, InstallationGuide...
    knowledge_type = Column(String)  # enum: faq, policy, product, logistics, compliance, brand_tone, sop, other
    category = Column(String)
    industry = Column(String)
    industries = Column(JSONB)
    sub_industries = Column(JSONB, default=list)  # string array, e.g. ["HomeAppliance_AirCon"]
    risk_level = Column(String, default="low")  # enum: low, medium, medium_high, high
    detected_language = Column(String)
    source_encoding = Column(String)
    ai_detection_confidence = Column(Numeric)
    suggested_action = Column(String, default="create_new")  # enum: create_new, update_existing, duplicate, needs_human_review
    matched_document_id = Column(String)
    matched_document_name = Column(String)
    matched_item_id = Column(String)
    matched_item_title = Column(String)
    matched_content_excerpt = Column(Text)
    similarity_score = Column(Numeric)
    diff_summary = Column(Text)
    duplicate_status = Column(String, default="none")  # enum: none, exact_duplicate, semantic_similar, true_conflict, new_content, unclear
    duplicate_reason = Column(Text)
    duplicate_action = Column(String, default="pending")  # enum: pending, overwrite_version, discard_import, keep_as_new, defer
    duplicate_resolved_at = Column(DateTime(timezone=True))
    conflict_type = Column(String, default="none")  # enum: none, direct_contradiction, policy_overlap, version_conflict, outdated_info, scope_clash
    conflict_summary = Column(Text)
    human_decision = Column(String, default="pending")  # enum: pending, ignored, accepted_ai, edited, create_new, update_existing, ignore, accept...
    review_status = Column(String, default="not_started")  # enum: not_started, reviewing, passed, needs_revision, blocked
    completeness_score = Column(Numeric)
    accuracy_score = Column(Numeric)
    clarity_score = Column(Numeric)
    quality_score = Column(Numeric)
    rag_readiness_score = Column(Numeric)
    conflict_risk_score = Column(Numeric)
    ai_issue_summary = Column(Text)
    ai_fix_suggestion = Column(String)
    blocking_issues = Column(JSONB)
    saved_document_id = Column(String)
    created_document_id = Column(String)
    status = Column(String, default="pending")  # enum: pending, reviewing, saved, ignored, failed, enumerated, extracting, needs_manual_check
    source_chunk_index = Column(Numeric)
    approx_start_marker = Column(String)
    approx_end_marker = Column(String)
    issue_type = Column(String)  # enum: section_heading_no_body, marker_not_found, content_misaligned, duplicate_content, original_content_not_found, other
    skip_reason = Column(Text)
    is_section_heading = Column(Boolean, default=False)
    parent_section_title = Column(String)
    source_metadata = Column(JSONB)
    is_deleted_from_publish = Column(Boolean, default=False)
    deleted_from_publish_at = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class KBIndustryCategory(Base, TimestampMixin, OwnershipMixin):
    """行業分類字典 — 取代 app/services/industry_groups.py 的 INDUSTRY_GROUPS 常數。

    自我參照樹狀結構：
      - 主分類：level=1、parent_id 為 NULL
      - 次分類：level=2、parent_id → 所屬主分類的 id

    value 全域唯一（分類代碼，如 HomeAppliance / HomeAppliance_AirCon）。
    非 Base44 39 個 production entity，故不列入 ALL_MODELS（不產生 CRUD 路由）。
    """
    __tablename__ = "kb_industry_category"
    id = Column(String, primary_key=True, default=gen_id)
    value = Column(String, nullable=False, unique=True)  # 分類代碼（唯一）
    label = Column(String, nullable=False)               # 名稱
    description = Column(Text)
    parent_id = Column(String)                           # 父分類 id（主分類為 NULL）
    level = Column(Numeric, default=1)                   # 1=主分類, 2=次分類
    source = Column(String, default="seed")              # enum: seed, llm_auto, manual
    is_active = Column(Boolean, default=True)
    sort_order = Column(Numeric, default=0)
    company_id = Column(Numeric)


class KBIndustryCategoryLog(Base, TimestampMixin, OwnershipMixin):
    """行業分類新增/拒絕日誌（LLM 自動新增分類的稽核軌跡）。

    記錄：發生時間（created_date）、來源（source）、內容（category_value /
    category_label / parent_value / payload）與操作者（created_by）。
    非 Base44 39 個 production entity，故不列入 ALL_MODELS。
    """
    __tablename__ = "kb_industry_category_log"
    id = Column(String, primary_key=True, default=gen_id)
    category_id = Column(String)                         # 關聯 kb_industry_category.id
    category_value = Column(String, nullable=False)
    category_label = Column(String)
    parent_value = Column(String)
    action = Column(String, nullable=False)              # enum: created, duplicate_skipped, rejected_invalid, rejected_disabled
    source = Column(String, nullable=False)              # enum: seed, llm_auto, manual
    reason = Column(Text)
    payload = Column(JSONB)                              # 原始觸發內容（LLM 回傳值等）
    created_by = Column(String)
    company_id = Column(Numeric)


class KBIndustryTemplate(Base, TimestampMixin, OwnershipMixin):
    """KBIndustryTemplate"""
    __tablename__ = "kb_industry_template"
    id = Column(String, primary_key=True, default=gen_id)
    industry = Column(String, nullable=False)  # enum: ecommerce, retail, healthcare, finance, insurance, food_beverage, beauty_wellness, electronics...
    business_type = Column(String)
    template_name = Column(String, nullable=False)
    source_type = Column(String)  # enum: FAQ, Product, TermsAndConditions, Policy, ReturnPolicy, DeliveryPolicy, WarrantyPolicy, InstallationGuide...
    template_content = Column(Text)
    required_fields = Column(JSONB)
    sample_questions = Column(JSONB)
    priority = Column(String, default="recommended")  # enum: required, recommended, optional
    is_active = Column(Boolean, default=True)
    company_id = Column(Numeric)


class KBPublishOperation(Base, TimestampMixin, OwnershipMixin):
    """KBPublishOperation"""
    __tablename__ = "kb_publish_operation"
    id = Column(String, primary_key=True, default=gen_id)
    idempotency_key = Column(String, nullable=False)
    document_ids = Column(JSONB, nullable=False)
    status = Column(String, default="preparing")  # enum: preparing, staging, production_writing, activating, completed, cancelling, cancelled, cancellation_failed...
    current_step = Column(String)
    processed_count = Column(Numeric, default=0)
    total_count = Column(Numeric, default=0)
    cancel_requested_at = Column(DateTime(timezone=True))
    cancelled_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    step_deadline_at = Column(DateTime(timezone=True))
    production_writing_status = Column(String, default="none")  # enum: none, in_progress, succeeded, failed, timed_out
    production_next_index = Column(Numeric, default=0)
    production_heartbeat_at = Column(DateTime(timezone=True))
    production_started_at = Column(DateTime(timezone=True))
    production_completed_at = Column(DateTime(timezone=True))
    production_failed_document_ids = Column(JSONB)
    production_errors = Column(JSONB)
    rollback_status = Column(String, default="none")  # enum: none, pending, in_progress, succeeded, failed, timed_out
    rollback_total_count = Column(Numeric, default=0)
    rollback_processed_count = Column(Numeric, default=0)
    rollback_next_index = Column(Numeric, default=0)
    rollback_current_document_id = Column(String)
    rollback_current_step = Column(String)
    rollback_started_at = Column(DateTime(timezone=True))
    rollback_heartbeat_at = Column(DateTime(timezone=True))
    rollback_completed_at = Column(DateTime(timezone=True))
    rollback_failed_document_ids = Column(JSONB)
    rollback_errors = Column(JSONB)
    rollback_results = Column(JSONB)
    previous_active_versions = Column(JSONB)
    candidate_version_ids = Column(JSONB)
    candidate_vector_ids = Column(JSONB)
    activation_status = Column(String, default="none")  # enum: none, in_progress, succeeded, failed, timed_out
    activation_total_count = Column(Numeric, default=0)
    activation_processed_count = Column(Numeric, default=0)
    activation_next_index = Column(Numeric, default=0)
    activation_current_document_id = Column(String)
    activation_current_substep = Column(String)
    activation_started_at = Column(DateTime(timezone=True))
    activation_heartbeat_at = Column(DateTime(timezone=True))
    activation_completed_at = Column(DateTime(timezone=True))
    activation_attempt_count = Column(Numeric, default=0)
    activation_failed_document_ids = Column(JSONB)
    activation_errors = Column(JSONB)
    continuation_locked_at = Column(DateTime(timezone=True))
    continuation_lock_owner = Column(String)
    continuation_lock_expires_at = Column(DateTime(timezone=True))
    continuation_retry_count = Column(Numeric, default=0)
    continuation_next_retry_at = Column(DateTime(timezone=True))
    continuation_last_error = Column(Text)
    error_code = Column(Text)
    error_detail = Column(Text)
    skipped_detection_types = Column(JSONB)
    detection_summary = Column(JSONB)
    result_summary = Column(JSONB)
    created_at = Column(DateTime(timezone=True))
    updated_at = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class KBReview(Base, TimestampMixin, OwnershipMixin):
    """KBReview"""
    __tablename__ = "kb_review"
    id = Column(String, primary_key=True, default=gen_id)
    document_id = Column(String, nullable=False)
    review_version = Column(String)
    overall_score = Column(Numeric)
    overall_status = Column(String, default="needs_revision")  # enum: passed, passed_with_warnings, needs_revision, blocked
    publish_decision = Column(String, default="needs_review")  # enum: ready, ready_with_review, needs_review, not_ready
    layer_results = Column(JSONB)
    blocking_issues = Column(JSONB)
    total_agents_run = Column(Numeric)
    review_started_at = Column(DateTime(timezone=True))
    review_completed_at = Column(DateTime(timezone=True))
    reviewed_by = Column(String, default="system")
    executed_agents_count = Column(Numeric, default=0)
    skipped_agents_count = Column(Numeric, default=0)
    total_applicable_agents_count = Column(Numeric, default=0)
    review_coverage_ratio = Column(Numeric)
    score_confidence = Column(String)  # enum: high, medium, low
    skipped_agent_keys = Column(JSONB)
    high_risk_agents_skipped = Column(Boolean, default=False)
    enabled_credit_weight = Column(Numeric, default=0)
    total_credit_weight = Column(Numeric, default=0)
    estimated_credit_saving_percent = Column(Numeric, default=0)
    company_id = Column(Numeric)


class KBReviewFixPreview(Base, TimestampMixin, OwnershipMixin):
    """KBReviewFixPreview"""
    __tablename__ = "kb_review_fix_preview"
    id = Column(String, primary_key=True, default=gen_id)
    document_id = Column(String, nullable=False)
    review_id = Column(String)
    document_version = Column(String)
    source_content_hash = Column(Text)
    general_only = Column(Boolean, default=False)
    frozen_plan = Column(JSONB)
    standards = Column(JSONB)
    findings = Column(JSONB)
    candidate_content = Column(Text)
    candidate_content_hash = Column(Text)
    prevalidation_status = Column(String, default="pending")  # enum: pending, passed, failed, stale, not_applicable
    prevalidation_review_id = Column(String)
    prevalidation_publish_decision = Column(String)  # enum: ready, ready_with_review, needs_review, not_ready
    prevalidation_overall_score = Column(Numeric)
    content_blockers = Column(Numeric, default=0)
    industry_blockers = Column(Numeric, default=0)
    prevalidation_agent_results = Column(JSONB)
    prevalidation_iterations = Column(Numeric, default=0)
    grounding_results = Column(JSONB)
    prevalidation_runtime_mismatch = Column(Boolean, default=False)
    mismatch_detail = Column(Text)
    integrity_failure = Column(Boolean, default=False)
    unrestored_entity_ids = Column(JSONB)
    applied_at = Column(DateTime(timezone=True))
    applied_by = Column(String)
    formal_review_id = Column(String)
    formal_publish_decision = Column(String)  # enum: ready, ready_with_review, needs_review, not_ready
    status = Column(String, default="preview")  # enum: preview, applied, mismatch, failed
    company_id = Column(Numeric)


class KBSyncLog(Base, TimestampMixin, OwnershipMixin):
    """KBSyncLog"""
    __tablename__ = "kb_sync_log"
    id = Column(String, primary_key=True, default=gen_id)
    global_document_id = Column(String, nullable=False)
    document_id = Column(String, nullable=False)
    version_id = Column(String)
    from_app = Column(String, nullable=False)  # enum: knowledge_base, ai_training, live_console, agent_studio, external
    to_app = Column(String, nullable=False)  # enum: knowledge_base, ai_training, live_console, agent_studio, external
    sync_type = Column(String, nullable=False)  # enum: proposal_received, proposal_reviewed, proposal_approved, proposal_rejected, proposal_merged, version_created_from_proposal, version_published, version_synced...
    sync_direction = Column(String, default="inbound")  # enum: inbound, outbound
    from_version = Column(String)
    to_version = Column(String)
    sync_status = Column(String, default="pending")  # enum: pending, in_progress, completed, failed, conflict
    conflict_status = Column(String, default="none")  # enum: none, detected, resolving, resolved
    error_message = Column(Text)
    created_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class KBUserPublishConfirmation(Base, TimestampMixin, OwnershipMixin):
    """KBUserPublishConfirmation"""
    __tablename__ = "kb_user_publish_confirmation"
    id = Column(String, primary_key=True, default=gen_id)
    document_id = Column(String, nullable=False)
    document_version = Column(String, nullable=False)
    effective_content_hash = Column(Text, nullable=False)
    review_id = Column(String)
    original_review_publish_decision = Column(String)
    approval_mode = Column(String, default="user_confirmation")  # enum: user_confirmation
    confirmation_content_checked = Column(Boolean, default=False)
    confirmation_business_suitability_accepted = Column(Boolean, default=False)
    confirmation_ai_use_acknowledged = Column(Boolean, default=False)
    confirmed_by = Column(String, nullable=False)
    confirmed_at = Column(DateTime(timezone=True), nullable=False)
    publish_attempt_id = Column(String)
    publish_result = Column(String, default="pending")  # enum: pending, success, partial, failed
    company_id = Column(Numeric)


class KBVectorChunk(Base, TimestampMixin, OwnershipMixin):
    """KBVectorChunk"""
    __tablename__ = "kb_vector_chunk"
    id = Column(String, primary_key=True, default=gen_id)
    document_id = Column(String, nullable=False)
    version_id = Column(String, nullable=False)
    chunk_index = Column(Numeric, default=0)
    chunk_text = Column(Text, nullable=False)
    chunk_type = Column(String, default="full_content")  # enum: full_content, rag_summary, faq_pair, section
    token_count = Column(Numeric, default=0)
    embedding_status = Column(String, default="pending")  # enum: pending, generating, generated, failed
    embedding_model = Column(String, default="gemini-embedding-001")
    embedding_vector = Column(JSONB)
    embedding_dimensions = Column(Numeric, default=768)
    embedded_at = Column(DateTime(timezone=True))
    embedding_error = Column(Text)
    vector_store = Column(String, default="local_embedding")  # enum: base44_placeholder, local_embedding, pinecone, pgvector, weaviate, vertex_matching_engine
    external_vector_id = Column(String)
    environment = Column(String, default="staging", nullable=False)  # enum: staging, production
    status = Column(String, default="active")  # enum: active, superseded, archived, failed
    company_id = Column(Numeric)


class PlatformLLMCreditBudget(Base, TimestampMixin, OwnershipMixin):
    """PlatformLLMCreditBudget"""
    __tablename__ = "kb_platform_llm_credit_budget"
    id = Column(String, primary_key=True, default=gen_id)
    scope_type = Column(String, nullable=False)  # enum: global, app, module, provider, task_type, agent, user, model_tier
    scope_key = Column(String, nullable=False)
    daily_limit_usd = Column(Numeric)
    monthly_limit_usd = Column(Numeric)
    current_day_usage_usd = Column(Numeric, default=0)
    current_month_usage_usd = Column(Numeric, default=0)
    warning_threshold_percent = Column(Numeric, default=80)
    hard_stop_threshold_percent = Column(Numeric, default=100)
    require_approval_when_over_budget = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    notes = Column(Text)
    company_id = Column(Numeric)


class PlatformLLMModelOption(Base, TimestampMixin, OwnershipMixin):
    """PlatformLLMModelOption"""
    __tablename__ = "kb_platform_llm_model_option"
    id = Column(String, primary_key=True, default=gen_id)
    provider_type = Column(String)
    model_id = Column(String)
    model_label = Column(String, nullable=False)
    model_tier = Column(String, nullable=False)  # enum: fast, balanced, reasoning, premium_reasoning
    cost_level = Column(String)  # enum: low, medium, high
    reasoning_strength = Column(Text)  # enum: basic, medium, strong
    recommended_use_cases = Column(JSONB)
    max_context_tokens = Column(Numeric)
    is_active = Column(Boolean, default=True)
    notes = Column(Text)
    created_at = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class PlatformLLMProviderConfig(Base, TimestampMixin, OwnershipMixin):
    """PlatformLLMProviderConfig"""
    __tablename__ = "kb_platform_llm_provider_config"
    id = Column(String, primary_key=True, default=gen_id)
    provider_name = Column(String, nullable=False)
    provider_type = Column(String, nullable=False)  # enum: openai, gemini, vertex_ai_gemini, deepseek, custom
    api_key = Column(String)
    api_key_masked = Column(String)
    api_base_url = Column(String)
    fast_model = Column(String)
    fast_model_label = Column(String)
    reasoning_model = Column(Text)
    reasoning_model_label = Column(Text)
    default_model_tier = Column(String, default="fast")  # enum: fast, reasoning
    temperature = Column(Numeric, default=0.3)
    max_tokens = Column(Numeric, default=4000)
    timeout_seconds = Column(Numeric, default=60)
    is_active = Column(Boolean, default=False)
    is_default = Column(Boolean, default=False)
    test_status = Column(String, default="not_tested")  # enum: not_tested, success, failed
    last_tested_at = Column(DateTime(timezone=True))
    last_test_latency_ms = Column(Numeric)
    last_test_error = Column(Text)
    vertex_project_id = Column(String)
    vertex_region = Column(String, default="asia-southeast1")
    vertex_service_account_secret_ref = Column(String)
    company_id = Column(Numeric)


class PlatformLLMRequestLog(Base, TimestampMixin, OwnershipMixin):
    """PlatformLLMRequestLog"""
    __tablename__ = "kb_platform_llm_request_log"
    id = Column(String, primary_key=True, default=gen_id)
    request_trace_id = Column(String, nullable=False)
    app_key = Column(String, nullable=False)  # enum: knowledge_base, ai_training, live_console, agent_studio, other
    module_key = Column(String)
    task_type = Column(String, nullable=False)
    agent_key = Column(String)
    source_object_type = Column(String)  # enum: kb_document, template_generation_job, training_case, live_conversation, other
    source_object_id = Column(String)
    provider_type = Column(String, nullable=False)
    provider_config_id = Column(String)
    model_used = Column(String, nullable=False)
    model_tier = Column(String, nullable=False)  # enum: fast, reasoning
    input_tokens = Column(Numeric)
    output_tokens = Column(Numeric)
    estimated_cost_usd = Column(Numeric)
    latency_ms = Column(Numeric)
    status = Column(String, nullable=False)  # enum: success, failed, timeout
    retry_count = Column(Numeric, default=0)
    fallback_used = Column(Boolean, default=False)
    fallback_provider_type = Column(String)
    error_code = Column(Text)  # enum: invalid_key, permission_denied, model_not_found, quota_exceeded, timeout, network_error, unknown
    error_message = Column(Text)
    company_id = Column(Numeric)


class PlatformLLMRoutingDecisionLog(Base, TimestampMixin, OwnershipMixin):
    """PlatformLLMRoutingDecisionLog"""
    __tablename__ = "kb_platform_llm_routing_decision_log"
    id = Column(String, primary_key=True, default=gen_id)
    request_trace_id = Column(String, nullable=False)
    app_key = Column(String, nullable=False)
    module_key = Column(String)
    task_type = Column(String, nullable=False)
    agent_key = Column(String)
    policy_id = Column(String)
    source_object_type = Column(String)
    source_object_id = Column(String)
    input_token_estimate = Column(Numeric)
    complexity_score = Column(Numeric)
    risk_score = Column(Numeric)
    selected_provider_type = Column(String)
    selected_provider_id = Column(String)
    selected_model = Column(String)
    selected_model_tier = Column(String, nullable=False)
    routing_reason = Column(Text, nullable=False)
    was_escalated = Column(Boolean, default=False)
    was_downgraded = Column(Boolean, default=False)
    fallback_used = Column(Boolean, default=False)
    fallback_reason = Column(Text)
    estimated_cost_usd = Column(Numeric)
    content_risk_level = Column(Text)  # enum: low, medium, high, critical
    content_complexity_level = Column(Text)  # enum: simple, normal, complex
    sensitivity_tags = Column(JSONB)
    content_risk_reason = Column(Text)
    matched_risk_keywords = Column(JSONB)
    recommended_model_tier_by_content = Column(Text)
    final_selected_model_tier = Column(String)
    downgrade_reason = Column(Text)
    escalation_reason = Column(Text)
    credit_budget_status = Column(String)  # enum: normal, warning, hard_stop
    budget_downgrade_applied = Column(Boolean, default=False)
    min_tier_protection_applied = Column(Boolean, default=False)
    company_id = Column(Numeric)


class PlatformLLMRoutingPolicy(Base, TimestampMixin, OwnershipMixin):
    """PlatformLLMRoutingPolicy"""
    __tablename__ = "kb_platform_llm_routing_policy"
    id = Column(String, primary_key=True, default=gen_id)
    policy_name = Column(String, nullable=False)
    app_key = Column(String)  # enum: knowledge_base, ai_training, live_console, agent_studio, template_generator, any
    module_key = Column(String)
    task_type = Column(String, nullable=False)  # enum: classification, metadata_extraction, template_generation, completeness_review, correctness_review, readability_review, contradiction_detection, compliance_review...
    agent_key = Column(String)
    default_model_tier = Column(String, default="fast")  # enum: fast, balanced, reasoning, premium_reasoning
    min_model_tier = Column(String, default="fast")  # enum: fast, balanced, reasoning, premium_reasoning
    max_model_tier = Column(String, default="premium_reasoning")  # enum: fast, balanced, reasoning, premium_reasoning
    preferred_provider_type = Column(String, default="any")
    fallback_provider_type = Column(String, default="any")
    max_input_tokens = Column(Numeric, default=8000)
    max_output_tokens = Column(Numeric, default=2000)
    max_estimated_cost_usd = Column(Numeric)
    allow_auto_escalation = Column(Boolean, default=True)
    allow_auto_downgrade = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    notes = Column(Text)
    company_id = Column(Numeric)


class TemplateGenerationJob(Base, TimestampMixin, OwnershipMixin):
    """TemplateGenerationJob"""
    __tablename__ = "kb_template_generation_job"
    id = Column(String, primary_key=True, default=gen_id)
    industry_key = Column(String, nullable=False)
    industry_label = Column(String, nullable=False)
    skeleton_id = Column(String)
    market_region = Column(String, default="general")  # enum: hong_kong, taiwan, macau, singapore, united_states, general
    status = Column(String, default="pending")  # enum: pending, generating, completed, failed
    language = Column(String, default="zh")  # enum: zh, en
    business_name = Column(String)
    business_description = Column(Text)
    total_templates = Column(Numeric, default=0)
    completed_templates = Column(Numeric, default=0)
    failed_templates = Column(Numeric, default=0)
    error_message = Column(Text)
    kb_import_batch_id = Column(String)
    completed_at = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class TrainingKnowledgeProposal(Base, TimestampMixin, OwnershipMixin):
    """TrainingKnowledgeProposal"""
    __tablename__ = "kb_training_knowledge_proposal"
    id = Column(String, primary_key=True, default=gen_id)
    proposal_id = Column(String)
    global_document_id = Column(String, nullable=False)
    source_app = Column(String, default="ai_training", nullable=False)  # enum: ai_training, live_console, agent_studio, external
    source_case_id = Column(String)
    source_cluster_id = Column(String)
    target_document_id = Column(String)
    base_version = Column(String, nullable=False)
    proposed_version = Column(String)
    proposed_content = Column(Text, nullable=False)
    proposed_rag_summary = Column(Text)
    reason = Column(Text)
    expected_score_improvement = Column(Numeric)
    severity = Column(String, default="p2_medium")  # enum: p0_critical, p1_high, p2_medium, p3_low
    status = Column(String, default="received", nullable=False)  # enum: received, validating, auto_ingested, indexed, failed, conflict, unmatched
    conflict_status = Column(String, default="none")  # enum: none, detected, resolving, resolved
    training_status = Column(String)  # enum: passed, failed
    final_score = Column(Numeric, default=None)
    before_score = Column(Numeric, default=None)
    after_score = Column(Numeric, default=None)
    failed_cases_count = Column(Numeric, default=0)
    approved_by_training = Column(Boolean, default=False)
    auto_ingest_error = Column(Text)
    failure_type = Column(String)  # enum: training_not_passed, score_below_threshold, not_approved_by_training, ingest_error, rag_error, vector_error
    reviewed_by = Column(String)
    reviewed_at = Column(DateTime(timezone=True))
    merged_version_id = Column(String)
    created_at = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class User(Base):
    """User — 對應 legacy system_users 表（integer serial id、created_at/updated_at）。

    不用 TimestampMixin/OwnershipMixin：該表沒有 created_date/updated_date/
    created_by/tenant_id 欄位，mixin 會讓所有 User 查詢報 UndefinedColumn。
    """
    __tablename__ = "system_users"
    id = Column(Integer, primary_key=True)   # legacy serial PK（非 gen_id hex）
    email = Column(String(100))
    full_name = Column(String(100))
    disabled = Column(Boolean, default=False)
    is_verified = Column(Boolean, default=False)
    app_id = Column(String(36))
    is_service = Column(Boolean, default=False)
    _app_role = Column(String(50), default="")
    role = Column(String(50), default="")
    password = Column(String(255))
    source = Column(String, default=None)
    ref_id = Column(Integer, default=None)
    company_id = Column(Integer, default=0)
    default_language = Column(String(10), default="en")
    created_at = Column(DateTime(timezone=True))
    updated_at = Column(DateTime(timezone=True))


class WebsiteContentCleaningRule(Base, TimestampMixin, OwnershipMixin):
    """WebsiteContentCleaningRule"""
    __tablename__ = "kb_website_content_cleaning_rule"
    id = Column(String, primary_key=True, default=gen_id)
    rule_name = Column(String, nullable=False)
    rule_name_en = Column(String)
    rule_type = Column(String, nullable=False)  # enum: keyword_blacklist, regex_pattern, line_pattern
    pattern = Column(String, nullable=False)
    apply_to = Column(String, default="all_websites")  # enum: all_websites, ecommerce, other
    is_active = Column(Boolean, default=True)
    priority = Column(Numeric)
    created_at = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class WebsiteImportJob(Base, TimestampMixin, OwnershipMixin):
    """WebsiteImportJob"""
    __tablename__ = "kb_website_import_job"
    id = Column(String, primary_key=True, default=gen_id)
    job_name = Column(String, nullable=False)
    input_url = Column(String, nullable=False)
    import_mode = Column(String, default="single_url")  # enum: single_url, sitemap, selected_pages
    status = Column(String, default="pending")  # enum: pending, validating, crawling, processing, completed, partial_success, failed
    total_pages_requested = Column(Numeric, default=0)
    total_pages_completed = Column(Numeric, default=0)
    total_pages_failed = Column(Numeric, default=0)
    firecrawl_job_id = Column(Text)
    error_message = Column(Text)
    completed_at = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class WebsiteImportLog(Base, TimestampMixin, OwnershipMixin):
    """WebsiteImportLog"""
    __tablename__ = "kb_website_import_log"
    id = Column(String, primary_key=True, default=gen_id)
    job_id = Column(String, nullable=False)
    page_result_id = Column(String)
    action = Column(String, nullable=False)
    status = Column(String, default="success", nullable=False)  # enum: success, warning, error
    message = Column(Text)
    company_id = Column(Numeric)


class AnalyticsEvent(Base, TimestampMixin, OwnershipMixin):
    """前端 analytics 埋點事件（POST /api/apps/{app_id}/analytics/track/batch 寫入）。

    非 Base44 39 個 production entity，故不列入 ALL_MODELS（不產生 CRUD 路由）。
    """
    __tablename__ = "kb_analytics_event"
    id = Column(String, primary_key=True, default=gen_id)
    app_id = Column(String)
    event_name = Column(String)
    event_type = Column(String, default="custom")
    user_id = Column(String)
    session_id = Column(String)
    page_url = Column(String)
    referrer = Column(String)
    properties = Column(JSONB)
    timestamp = Column(DateTime(timezone=True))
    company_id = Column(Numeric)


class FirecrawlLog(Base):
    """Firecrawl API 呼叫日誌（kb_firecrawl_log）。

    schema 對齊舊版 knowledge-base 服務的 KBFirecrawlLog（共用同一張表）：
    id(serial) / webhook_id / success / type / data(jsonb) / company_id /
    created_at(unix) / updated_at(unix) / status / credits_used

    非 Base44 39 個 production entity，故不列入 ALL_MODELS（不產生 CRUD 路由）。
    """
    __tablename__ = "kb_firecrawl_log"
    id = Column(Integer, primary_key=True, autoincrement=True)
    webhook_id = Column(String(100), default="0")
    success = Column(Boolean, default=False)
    type = Column(String(25))  # ex: scrape, crawl, crawl_status, credit_usage
    data = Column(JSONB)       # request/response/error/duration 等明細
    company_id = Column(Integer, default=0)
    created_at = Column(Integer)  # unix timestamp
    updated_at = Column(Integer)
    status = Column(Integer, default=0)  # 1=success, 0=failed
    credits_used = Column(Integer)


class Company(Base):
    """平台共享 company 表（由 Base44 平台維護，僅供唯讀查詢）。

    用於 POST /api/v1/rag/context-search 的 api_key header 認證：
    以 api_key 解析出 company_id，再套 company 隔離檢索。
    非 Base44 39 個 production entity，故不列入 ALL_MODELS（不產生 CRUD 路由）。
    """
    __tablename__ = "company"
    id = Column(Integer, primary_key=True)
    name = Column(String)
    status = Column(Integer)
    api_key = Column(String(64))


# ── 排除清單（不建立 production table）──
EXCLUDED_NOOP_ENTITIES = ["_invalid_noop", "_noop", "_noop10", "_noop11", "_noop13", "_noop2", "_noop3", "_noop4", "_noop5", "_noop6", "_noop7", "_noop8", "_noop9", "_noop_temp", "_noop_temp2", "noop", "noop2", "noop3", "noop_ui_check"]

# 真實 entity 總數: 39
ALL_MODELS = [
    CrawledPageResult,
    FirecrawlConfig,
    GeneratedTemplateItem,
    IndustryTemplateSkeleton,
    KBAgentRegistry,
    KBAgentResult,
    KBAgentToggleAuditLog,
    KBAgentToggleConfig,
    KBAuditEvent,
    KBCategorySchema,
    KBConfig,
    KBConflict,
    KBDiffResult,
    KBDocument,
    KBDocumentVersion,
    KBGuestImportSession,
    KBGuestUATProbe,
    KBHallucinationEvent,
    KBImportBatch,
    KBImportItem,
    KBIndustryTemplate,
    KBPublishOperation,
    KBReview,
    KBReviewFixPreview,
    KBSyncLog,
    KBUserPublishConfirmation,
    KBVectorChunk,
    PlatformLLMCreditBudget,
    PlatformLLMModelOption,
    PlatformLLMProviderConfig,
    PlatformLLMRequestLog,
    PlatformLLMRoutingDecisionLog,
    PlatformLLMRoutingPolicy,
    TemplateGenerationJob,
    TrainingKnowledgeProposal,
    User,
    WebsiteContentCleaningRule,
    WebsiteImportJob,
    WebsiteImportLog,
]
