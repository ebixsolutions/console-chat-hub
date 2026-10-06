-- Offline disposable native PostgreSQL 17 harness. No production/customer records.
-- auth.uid()/role() below represent local SQL subjects ONLY; no hosted Auth PASS.
SET check_function_bodies=false;
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role',true),''),current_user) $$;
GRANT USAGE ON SCHEMA public,auth,extensions TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION auth.uid(),auth.role() TO anon,authenticated,service_role;
CREATE TYPE public."app_role" AS ENUM ('admin','supervisor','agent','qa');
CREATE TABLE public."agent_profile"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"user_id" uuid,"display_name" text NOT NULL,"email" text NOT NULL,"role" text NOT NULL DEFAULT 'agent'::text,"status" text DEFAULT 'active'::text,"avatar_url" text,"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now());
CREATE TABLE public."audit_log"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"actor_id" uuid,"actor_type" text,"action" text NOT NULL,"resource_type" text NOT NULL,"resource_id" uuid,"diff" jsonb DEFAULT '{}'::jsonb,"ip_address" text,"created_at" timestamp with time zone DEFAULT now());
CREATE TABLE public."ce_bundle_snapshot"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"attempt_id" uuid NOT NULL,"conversation_id" uuid NOT NULL,"company_id" uuid NOT NULL,"bundle_hash" text NOT NULL,"transcript_hash" text NOT NULL,"evaluation_contract_version" text NOT NULL,"model_version" text NOT NULL,"prompt_version" text NOT NULL,"kb_snapshot_id" text NOT NULL,"policy_snapshot_id" text NOT NULL,"canonical_input" text NOT NULL,"normalized_transcript" jsonb NOT NULL,"evaluated_ai_reply" jsonb,"verified_human_response" jsonb,"grounding_evidence" jsonb NOT NULL,"grounding_manifest" jsonb NOT NULL,"truncation_manifest" jsonb NOT NULL,"redaction_applied" boolean NOT NULL DEFAULT true,"retention_expires_at" timestamp with time zone NOT NULL DEFAULT (now() + '180 days'::interval),"created_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public."ce_discrepancy"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"evaluation_id" uuid NOT NULL,"company_id" uuid NOT NULL,"dimension" text NOT NULL,"ai_claim" text NOT NULL,"human_claim" text,"grounded_claim" text,"divergence_kind" text NOT NULL,"severity" text NOT NULL,"grounding_refs" jsonb NOT NULL DEFAULT '[]'::jsonb,"created_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public."ce_evaluation_job"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"job_key" text NOT NULL,"conversation_id" uuid NOT NULL,"company_id" uuid NOT NULL,"snapshot_hash" text NOT NULL,"evaluation_fingerprint" text NOT NULL,"expected_revision" bigint NOT NULL,"source" text NOT NULL,"priority" integer NOT NULL,"status" text NOT NULL DEFAULT 'queued'::text,"available_at" timestamp with time zone NOT NULL DEFAULT now(),"attempts" integer NOT NULL DEFAULT 0,"max_attempts" integer NOT NULL DEFAULT 3,"lease_owner" text,"lease_expires_at" timestamp with time zone,"started_at" timestamp with time zone,"finished_at" timestamp with time zone,"error_code" text,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"updated_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public."ce_evaluation_methodology"("evaluation_fingerprint" text NOT NULL,"evaluation_contract_version" text NOT NULL,"evaluator_prompt_version" text NOT NULL,"prompt_hash" text NOT NULL,"scoring_config_hash" text NOT NULL,"evaluator_schema_hash" text NOT NULL,"status" text NOT NULL,"activated_at" timestamp with time zone,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"updated_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public."ce_evaluation_state"("conversation_id" uuid NOT NULL,"company_id" uuid NOT NULL,"state" text NOT NULL DEFAULT 'never_evaluated'::text,"revision" bigint NOT NULL DEFAULT 0,"current_snapshot_hash" text,"current_evaluation_fingerprint" text,"last_success_evaluation_id" uuid,"last_success_source" text,"last_success_snapshot_hash" text,"last_success_fingerprint" text,"last_success_at" timestamp with time zone,"dirty_since" timestamp with time zone,"last_activity_at" timestamp with time zone,"queued_at" timestamp with time zone,"evaluating_started_at" timestamp with time zone,"last_error_code" text,"updated_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public."ce_kb_publish_state"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"evaluation_id" uuid NOT NULL,"company_id" uuid NOT NULL,"kb_document_ref" text NOT NULL,"action" text NOT NULL,"state" text NOT NULL DEFAULT 'requested'::text,"requested_by" uuid NOT NULL,"remote_sync_state" text NOT NULL DEFAULT 'pending'::text,"remote_ref" text,"last_error" text,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"updated_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public."ce_local_evaluation_attempt"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"conversation_id" uuid NOT NULL,"evaluation_contract_version" text NOT NULL,"input_snapshot_hash" text NOT NULL,"bundle_hash" text NOT NULL,"status" text NOT NULL,"pipeline_run_id" uuid NOT NULL DEFAULT gen_random_uuid(),"initiated_by" uuid NOT NULL,"model_version" text NOT NULL,"prompt_version" text NOT NULL,"source_deployment" text NOT NULL,"error_code" text,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"updated_at" timestamp with time zone NOT NULL DEFAULT now(),"company_id" uuid,"rebound_run_id" uuid,"rebound_at" timestamp with time zone,"evaluation_fingerprint" text,"initiated_by_kind" text NOT NULL DEFAULT 'user'::text);
CREATE TABLE public."ce_training_link"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"evaluation_id" uuid NOT NULL,"company_id" uuid NOT NULL,"link_kind" text NOT NULL,"local_state" text NOT NULL DEFAULT 'proposed'::text,"payload" jsonb NOT NULL DEFAULT '{}'::jsonb,"improved_result" jsonb,"improved_state" text NOT NULL DEFAULT 'pending'::text,"remote_sync_state" text NOT NULL DEFAULT 'pending'::text,"remote_ref" text,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"updated_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public."channel_config"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"name" text NOT NULL,"channel_type" text NOT NULL DEFAULT 'web_widget'::text,"widget_config_id" uuid,"allowed_origins" text[] DEFAULT '{}'::text[],"is_active" boolean DEFAULT true,"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now(),"company_id" uuid);
CREATE TABLE public."company"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"slug" text NOT NULL,"display_name" text NOT NULL,"external_workspace_id" text NOT NULL,"external_tenant_id" text NOT NULL,"is_active" boolean NOT NULL DEFAULT true,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"platform_company_id" bigint NOT NULL);
CREATE TABLE public."company_membership"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"company_id" uuid NOT NULL,"user_id" uuid NOT NULL,"role" app_role NOT NULL,"is_active" boolean NOT NULL DEFAULT true,"created_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public."conversation_assignment"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"conversation_id" uuid NOT NULL,"agent_id" uuid NOT NULL,"assigned_by" uuid,"assigned_at" timestamp with time zone DEFAULT now(),"unassigned_at" timestamp with time zone,"is_active" boolean DEFAULT true);
CREATE TABLE public."conversation_evaluation"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"attempt_id" uuid NOT NULL,"conversation_id" uuid NOT NULL,"evaluation_contract_version" text NOT NULL,"input_snapshot_hash" text NOT NULL,"accuracy_score" numeric(5,2) NOT NULL,"policy_score" numeric(5,2) NOT NULL,"tone_score" numeric(5,2) NOT NULL,"sales_score" numeric(5,2) NOT NULL,"context_score" numeric(5,2) NOT NULL,"hallucination_risk_score" numeric(5,2) NOT NULL,"hallucination_quality_score" numeric(5,2) NOT NULL GENERATED ALWAYS AS ((100.0 - hallucination_risk_score)) STORED,"overall_score" numeric(5,2) NOT NULL,"severity" text NOT NULL,"has_verified_human_response" boolean NOT NULL DEFAULT false,"training_eligible" boolean NOT NULL DEFAULT false,"model_version" text NOT NULL,"prompt_version" text NOT NULL,"kb_snapshot_id" text NOT NULL,"policy_snapshot_id" text NOT NULL,"source_deployment" text NOT NULL,"evaluated_by" uuid NOT NULL,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"company_id" uuid NOT NULL,"review_status" text NOT NULL DEFAULT 'pending'::text,"review_note" text,"reviewed_by" uuid,"reviewed_at" timestamp with time zone,"bundle_hash" text,"grounding_manifest" jsonb,"evaluation_fingerprint" text,"freshness" text NOT NULL DEFAULT 'current'::text);
CREATE TABLE public."conversation_evaluation_attempt"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"conversation_id" uuid NOT NULL,"evaluation_contract_version" text NOT NULL DEFAULT 'v1'::text,"input_snapshot_hash" text NOT NULL,"status" text NOT NULL DEFAULT 'running'::text,"pipeline_run_id" uuid NOT NULL DEFAULT gen_random_uuid(),"initiated_by" uuid NOT NULL,"kb_snapshot_id" text NOT NULL,"policy_snapshot_id" text NOT NULL,"model_version" text NOT NULL,"prompt_version" text NOT NULL,"source_deployment" text NOT NULL,"error_message" text,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"updated_at" timestamp with time zone NOT NULL DEFAULT now(),"company_id" uuid NOT NULL,"bundle_hash" text,"grounding_manifest" jsonb,"evaluation_fingerprint" text,"initiated_by_kind" text NOT NULL DEFAULT 'user'::text);
CREATE TABLE public."conversations"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"visitor_session_id" uuid,"channel_config_id" uuid,"status" text NOT NULL DEFAULT 'open'::text,"assigned_agent_id" uuid,"priority" text DEFAULT 'normal'::text,"tags" text[] DEFAULT '{}'::text[],"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now(),"resolved_at" timestamp with time zone,"company_id" uuid,"customer_tier" text,"intent" text,"language" text,"metadata_source" jsonb NOT NULL DEFAULT '{}'::jsonb,"metadata_updated_at" timestamp with time zone);
CREATE TABLE public."evaluation_training_outbox"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"evaluation_id" uuid NOT NULL,"status" text NOT NULL DEFAULT 'pending'::text,"delivery_attempts" integer NOT NULL DEFAULT 0,"max_attempts" integer NOT NULL DEFAULT 3,"last_attempt_at" timestamp with time zone,"last_error" text,"delivered_at" timestamp with time zone,"delivery_idempotency_key" text NOT NULL,"source_app" text NOT NULL DEFAULT 'ai_chatbot'::text,"source_deployment" text NOT NULL,"evaluation_contract_version" text NOT NULL,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"company_id" uuid NOT NULL);
CREATE TABLE public."feedback_request"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"conversation_id" uuid NOT NULL,"visitor_session_id" uuid,"request_type" text DEFAULT 'csat'::text,"status" text DEFAULT 'pending'::text,"rating" integer,"feedback_text" text,"sent_at" timestamp with time zone,"responded_at" timestamp with time zone,"scheduled_at" timestamp with time zone,"channel" text,"rating_type" text NOT NULL DEFAULT 'stars_1_5'::text,"config_version_id" uuid,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"updated_at" timestamp with time zone NOT NULL DEFAULT now(),"response_token_hash" text,"token_expires_at" timestamp with time zone,"token_used_at" timestamp with time zone,"token_created_at" timestamp with time zone,"recipient_email" text,"delivery_status" text DEFAULT 'pending'::text,"delivery_error_type" text,"email_provider" text,"email_provider_message_id" text,"delivery_event_received_at" timestamp with time zone);
CREATE TABLE public."handoff_event"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"conversation_id" uuid NOT NULL,"handoff_reason" text NOT NULL,"handoff_type" text NOT NULL,"from_agent_id" uuid,"to_agent_id" uuid,"ai_summary" text,"created_at" timestamp with time zone DEFAULT now(),"source_message_id" uuid,"branch_tag" text,"escalation_rule" text,"safe_reply_content" text);
CREATE TABLE public."hf3_learning_case"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"company_id" uuid NOT NULL,"conversation_id" uuid NOT NULL,"evaluation_id" uuid NOT NULL,"feedback_request_id" uuid,"source_handoff_event_id" uuid,"intent_key" text,"handoff_classification" text NOT NULL DEFAULT 'not_applicable'::text,"classification_reason_codes" jsonb NOT NULL DEFAULT '[]'::jsonb,"feedback_quality_score" numeric,"has_negative_feedback" boolean NOT NULL DEFAULT false,"has_verified_human_response" boolean NOT NULL DEFAULT false,"ai_answer_sha256" text,"human_answer_sha256" text,"answer_delta_dimensions" jsonb NOT NULL DEFAULT '[]'::jsonb,"training_candidate" boolean NOT NULL DEFAULT false,"candidate_reason_codes" jsonb NOT NULL DEFAULT '[]'::jsonb,"training_outbox_id" uuid,"learning_state" text NOT NULL DEFAULT 'observed'::text,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"updated_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public."human_support_queue"("conversation_id" uuid NOT NULL,"company_id" uuid NOT NULL,"queued_at" timestamp with time zone NOT NULL DEFAULT now(),"priority" integer NOT NULL DEFAULT 100,"state" text NOT NULL DEFAULT 'waiting'::text,"assigned_agent_id" uuid,"assigned_at" timestamp with time zone,"closed_at" timestamp with time zone,"updated_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public."messages"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"conversation_id" uuid NOT NULL,"role" text NOT NULL,"content" text NOT NULL,"content_type" text DEFAULT 'text'::text,"status" text DEFAULT 'delivered'::text,"is_recalled" boolean DEFAULT false,"metadata" jsonb DEFAULT '{}'::jsonb,"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now(),"sender_id" uuid,"sender_identity_verified_at" timestamp with time zone,"sender_identity_source" text);
CREATE TABLE public."user_roles"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"user_id" uuid NOT NULL,"role" app_role NOT NULL,"created_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public."visitor_session"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"session_token" text NOT NULL DEFAULT (gen_random_uuid())::text,"channel_config_id" uuid,"visitor_fingerprint" text,"visitor_metadata" jsonb DEFAULT '{}'::jsonb,"last_seen_at" timestamp with time zone DEFAULT now(),"created_at" timestamp with time zone DEFAULT now());
CREATE TABLE public."widget_config"("id" uuid NOT NULL DEFAULT gen_random_uuid(),"name" text NOT NULL,"header_title" text NOT NULL DEFAULT 'Customer Support'::text,"welcome_message" text DEFAULT 'Hi! How can I help you today?'::text,"placeholder_text" text DEFAULT 'Type your message...'::text,"primary_color" text DEFAULT '#6B5CE7'::text,"logo_url" text,"is_active" boolean DEFAULT true,"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now(),"appearance_theme" text NOT NULL DEFAULT 'modern'::text,"launcher_icon" text NOT NULL DEFAULT 'chat'::text);
CREATE TABLE public."ce_automation_runtime"("singleton" boolean NOT NULL DEFAULT true,"enabled" boolean NOT NULL DEFAULT false,"worker_url" text,"worker_secret_id" uuid,"worker_token_hash" text,"debounce_minutes" integer NOT NULL DEFAULT 10,"max_age_minutes" integer NOT NULL DEFAULT 120,"background_sweep_minutes" integer NOT NULL DEFAULT 60,"global_concurrency" integer NOT NULL DEFAULT 3,"per_company_concurrency" integer NOT NULL DEFAULT 1,"enqueue_batch_limit" integer NOT NULL DEFAULT 100,"last_background_sweep_at" timestamp with time zone,"updated_at" timestamp with time zone NOT NULL DEFAULT now(),"automation_started_at" timestamp with time zone);
CREATE TABLE public."conversation_commerce_state"("conversation_id" uuid NOT NULL,"company_id" uuid NOT NULL,"revision" bigint NOT NULL DEFAULT 1,"source_message_id" uuid NOT NULL,"state" jsonb NOT NULL,"state_hash" text NOT NULL,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"updated_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public."conversation_memory_state"("conversation_id" uuid NOT NULL,"company_id" uuid NOT NULL,"revision" bigint NOT NULL DEFAULT 1,"source_message_id" uuid NOT NULL,"commerce_state_revision" bigint,"memory" jsonb NOT NULL,"markdown_projection" text NOT NULL,"memory_hash" text NOT NULL,"updated_from_turn" bigint NOT NULL,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"updated_at" timestamp with time zone NOT NULL DEFAULT now());
ALTER TABLE public."agent_profile" ADD CONSTRAINT "agent_profile_pkey" PRIMARY KEY (id);
ALTER TABLE public."agent_profile" ADD CONSTRAINT "agent_profile_role_check" CHECK ((role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'manager'::text, 'supervisor'::text, 'agent'::text, 'viewer'::text])));
ALTER TABLE public."agent_profile" ADD CONSTRAINT "agent_profile_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'suspended'::text])));
ALTER TABLE public."agent_profile" ADD CONSTRAINT "agent_profile_user_id_key" UNIQUE (user_id);
ALTER TABLE public."audit_log" ADD CONSTRAINT "audit_log_actor_type_check" CHECK ((actor_type = ANY (ARRAY['agent'::text, 'visitor'::text, 'system'::text, 'ai'::text])));
ALTER TABLE public."audit_log" ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY (id);
ALTER TABLE public."ce_bundle_snapshot" ADD CONSTRAINT "ce_bundle_snapshot_attempt_id_key" UNIQUE (attempt_id);
ALTER TABLE public."ce_bundle_snapshot" ADD CONSTRAINT "ce_bundle_snapshot_bundle_hash_check" CHECK ((bundle_hash ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE public."ce_bundle_snapshot" ADD CONSTRAINT "ce_bundle_snapshot_pkey" PRIMARY KEY (id);
ALTER TABLE public."ce_bundle_snapshot" ADD CONSTRAINT "ce_bundle_snapshot_transcript_hash_check" CHECK ((transcript_hash ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE public."ce_discrepancy" ADD CONSTRAINT "ce_discrepancy_dimension_check" CHECK ((dimension = ANY (ARRAY['accuracy'::text, 'policy'::text, 'tone'::text, 'sales'::text, 'context'::text, 'hallucination'::text])));
ALTER TABLE public."ce_discrepancy" ADD CONSTRAINT "ce_discrepancy_divergence_kind_check" CHECK ((divergence_kind = ANY (ARRAY['contradiction'::text, 'omission'::text, 'overreach'::text, 'unsupported'::text, 'style'::text])));
ALTER TABLE public."ce_discrepancy" ADD CONSTRAINT "ce_discrepancy_pkey" PRIMARY KEY (id);
ALTER TABLE public."ce_discrepancy" ADD CONSTRAINT "ce_discrepancy_severity_check" CHECK ((severity = ANY (ARRAY['critical'::text, 'high'::text, 'medium'::text, 'low'::text])));
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_evaluation_job_attempts_check" CHECK ((attempts >= 0));
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_evaluation_job_conversation_id_snapshot_hash_evaluation__key" UNIQUE (conversation_id, snapshot_hash, evaluation_fingerprint);
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_evaluation_job_evaluation_fingerprint_check" CHECK ((evaluation_fingerprint ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_evaluation_job_expected_revision_check" CHECK ((expected_revision >= 0));
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_evaluation_job_job_key_check" CHECK ((job_key ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_evaluation_job_job_key_key" UNIQUE (job_key);
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_evaluation_job_max_attempts_check" CHECK (((max_attempts >= 1) AND (max_attempts <= 10)));
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_evaluation_job_pkey" PRIMARY KEY (id);
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_evaluation_job_priority_check" CHECK (((priority >= 0) AND (priority <= 100)));
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_evaluation_job_snapshot_hash_check" CHECK ((length(TRIM(BOTH FROM snapshot_hash)) > 0));
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_evaluation_job_source_check" CHECK ((source = ANY (ARRAY['scheduler'::text, 'ce_dwell'::text, 'resolved'::text, 'verified_correction'::text, 'manual'::text, 'max_age'::text])));
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_evaluation_job_status_check" CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])));
ALTER TABLE public."ce_evaluation_methodology" ADD CONSTRAINT "ce_evaluation_methodology_evaluation_contract_version_check" CHECK ((length(TRIM(BOTH FROM evaluation_contract_version)) > 0));
ALTER TABLE public."ce_evaluation_methodology" ADD CONSTRAINT "ce_evaluation_methodology_evaluation_fingerprint_check" CHECK ((evaluation_fingerprint ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE public."ce_evaluation_methodology" ADD CONSTRAINT "ce_evaluation_methodology_evaluator_prompt_version_check" CHECK ((length(TRIM(BOTH FROM evaluator_prompt_version)) > 0));
ALTER TABLE public."ce_evaluation_methodology" ADD CONSTRAINT "ce_evaluation_methodology_evaluator_schema_hash_check" CHECK ((evaluator_schema_hash ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE public."ce_evaluation_methodology" ADD CONSTRAINT "ce_evaluation_methodology_pkey" PRIMARY KEY (evaluation_fingerprint);
ALTER TABLE public."ce_evaluation_methodology" ADD CONSTRAINT "ce_evaluation_methodology_prompt_hash_check" CHECK ((prompt_hash ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE public."ce_evaluation_methodology" ADD CONSTRAINT "ce_evaluation_methodology_scoring_config_hash_check" CHECK ((scoring_config_hash ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE public."ce_evaluation_methodology" ADD CONSTRAINT "ce_evaluation_methodology_status_check" CHECK ((status = ANY (ARRAY['candidate'::text, 'current'::text, 'retired'::text])));
ALTER TABLE public."ce_evaluation_state" ADD CONSTRAINT "ce_evaluation_state_last_success_source_check" CHECK (((last_success_source IS NULL) OR (last_success_source = ANY (ARRAY['canonical'::text, 'conversation_local'::text]))));
ALTER TABLE public."ce_evaluation_state" ADD CONSTRAINT "ce_evaluation_state_pkey" PRIMARY KEY (conversation_id);
ALTER TABLE public."ce_evaluation_state" ADD CONSTRAINT "ce_evaluation_state_revision_check" CHECK ((revision >= 0));
ALTER TABLE public."ce_evaluation_state" ADD CONSTRAINT "ce_evaluation_state_state_check" CHECK ((state = ANY (ARRAY['never_evaluated'::text, 'up_to_date'::text, 'dirty'::text, 'queued'::text, 'evaluating'::text, 'failed'::text, 'stale_version'::text])));
ALTER TABLE public."ce_kb_publish_state" ADD CONSTRAINT "ce_kb_publish_state_action_check" CHECK ((action = ANY (ARRAY['publish'::text, 'rollback'::text])));
ALTER TABLE public."ce_kb_publish_state" ADD CONSTRAINT "ce_kb_publish_state_document_ref_nonempty_check" CHECK ((length(btrim(kb_document_ref)) > 0));
ALTER TABLE public."ce_kb_publish_state" ADD CONSTRAINT "ce_kb_publish_state_pkey" PRIMARY KEY (id);
ALTER TABLE public."ce_kb_publish_state" ADD CONSTRAINT "ce_kb_publish_state_remote_sync_state_check" CHECK ((remote_sync_state = ANY (ARRAY['pending'::text, 'in_progress'::text, 'synced'::text, 'failed'::text, 'not_applicable'::text])));
ALTER TABLE public."ce_kb_publish_state" ADD CONSTRAINT "ce_kb_publish_state_state_check" CHECK ((state = ANY (ARRAY['requested'::text, 'in_progress'::text, 'published'::text, 'rolled_back'::text, 'failed'::text])));
ALTER TABLE public."ce_local_evaluation_attempt" ADD CONSTRAINT "ce_local_evaluation_attempt_initiated_by_kind_check" CHECK ((initiated_by_kind = ANY (ARRAY['user'::text, 'automation'::text])));
ALTER TABLE public."ce_local_evaluation_attempt" ADD CONSTRAINT "ce_local_evaluation_attempt_pkey" PRIMARY KEY (id);
ALTER TABLE public."ce_local_evaluation_attempt" ADD CONSTRAINT "ce_local_evaluation_attempt_status_check" CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])));
ALTER TABLE public."ce_training_link" ADD CONSTRAINT "ce_training_link_evaluation_id_link_kind_key" UNIQUE (evaluation_id, link_kind);
ALTER TABLE public."ce_training_link" ADD CONSTRAINT "ce_training_link_improved_state_check" CHECK ((improved_state = ANY (ARRAY['pending'::text, 'received'::text, 'not_applicable'::text])));
ALTER TABLE public."ce_training_link" ADD CONSTRAINT "ce_training_link_link_kind_check" CHECK ((link_kind = ANY (ARRAY['training_candidate'::text, 'kb_gap'::text])));
ALTER TABLE public."ce_training_link" ADD CONSTRAINT "ce_training_link_local_state_check" CHECK ((local_state = ANY (ARRAY['proposed'::text, 'accepted'::text, 'rejected'::text, 'delivered'::text])));
ALTER TABLE public."ce_training_link" ADD CONSTRAINT "ce_training_link_pkey" PRIMARY KEY (id);
ALTER TABLE public."ce_training_link" ADD CONSTRAINT "ce_training_link_remote_sync_state_check" CHECK ((remote_sync_state = ANY (ARRAY['pending'::text, 'synced'::text, 'failed'::text, 'not_applicable'::text])));
ALTER TABLE public."channel_config" ADD CONSTRAINT "channel_config_channel_type_check" CHECK ((channel_type = ANY (ARRAY['web_widget'::text, 'mobile'::text, 'api'::text])));
ALTER TABLE public."channel_config" ADD CONSTRAINT "channel_config_pkey" PRIMARY KEY (id);
ALTER TABLE public."company" ADD CONSTRAINT "company_display_name_check" CHECK ((length(btrim(display_name)) > 0));
ALTER TABLE public."company" ADD CONSTRAINT "company_external_tenant_id_check" CHECK ((length(btrim(external_tenant_id)) > 0));
ALTER TABLE public."company" ADD CONSTRAINT "company_external_workspace_id_check" CHECK ((length(btrim(external_workspace_id)) > 0));
ALTER TABLE public."company" ADD CONSTRAINT "company_external_workspace_id_external_tenant_id_key" UNIQUE (external_workspace_id, external_tenant_id);
ALTER TABLE public."company" ADD CONSTRAINT "company_pkey" PRIMARY KEY (id);
ALTER TABLE public."company" ADD CONSTRAINT "company_platform_company_id_positive_check" CHECK ((platform_company_id > 0));
ALTER TABLE public."company" ADD CONSTRAINT "company_slug_check" CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'::text));
ALTER TABLE public."company" ADD CONSTRAINT "company_slug_key" UNIQUE (slug);
ALTER TABLE public."company_membership" ADD CONSTRAINT "company_membership_company_id_user_id_role_key" UNIQUE (company_id, user_id, role);
ALTER TABLE public."company_membership" ADD CONSTRAINT "company_membership_pkey" PRIMARY KEY (id);
ALTER TABLE public."conversation_assignment" ADD CONSTRAINT "conversation_assignment_pkey" PRIMARY KEY (id);
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "ce_review_consistency_check" CHECK ((((review_status = 'pending'::text) AND (reviewed_by IS NULL) AND (reviewed_at IS NULL)) OR ((review_status <> 'pending'::text) AND (reviewed_by IS NOT NULL) AND (reviewed_at IS NOT NULL))));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "ce_review_status_check" CHECK ((review_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text])));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_accuracy_score_check" CHECK (((accuracy_score >= (0)::numeric) AND (accuracy_score <= (100)::numeric)));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_attempt_id_key" UNIQUE (attempt_id);
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_context_score_check" CHECK (((context_score >= (0)::numeric) AND (context_score <= (100)::numeric)));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_evaluation_contract_version_check" CHECK ((length(btrim(evaluation_contract_version)) > 0));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_freshness_check" CHECK ((freshness = ANY (ARRAY['current'::text, 'superseded'::text])));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_hallucination_quality_score_check" CHECK (((hallucination_quality_score >= (0)::numeric) AND (hallucination_quality_score <= (100)::numeric) AND (hallucination_quality_score = round(((100)::numeric - hallucination_risk_score), 2))));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_hallucination_risk_score_check" CHECK (((hallucination_risk_score >= (0)::numeric) AND (hallucination_risk_score <= (100)::numeric)));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_input_snapshot_hash_check" CHECK ((input_snapshot_hash ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_kb_snapshot_id_check" CHECK ((length(btrim(kb_snapshot_id)) > 0));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_model_version_check" CHECK ((length(btrim(model_version)) > 0));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_pkey" PRIMARY KEY (id);
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_policy_score_check" CHECK (((policy_score >= (0)::numeric) AND (policy_score <= (100)::numeric)));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_policy_snapshot_id_check" CHECK ((length(btrim(policy_snapshot_id)) > 0));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_prompt_version_check" CHECK ((length(btrim(prompt_version)) > 0));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_sales_score_check" CHECK (((sales_score >= (0)::numeric) AND (sales_score <= (100)::numeric)));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_severity_check" CHECK ((severity = ANY (ARRAY['critical'::text, 'high'::text, 'medium'::text, 'low'::text])));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_source_deployment_check" CHECK ((source_deployment ~ '^[A-Za-z0-9._:-]{1,128}$'::text));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_tone_score_check" CHECK (((tone_score >= (0)::numeric) AND (tone_score <= (100)::numeric)));
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "severity_score_consistent" CHECK ((((severity = 'critical'::text) AND (overall_score < (60)::numeric)) OR ((severity = 'high'::text) AND (overall_score >= (60)::numeric) AND (overall_score < (70)::numeric)) OR ((severity = 'medium'::text) AND (overall_score >= (70)::numeric) AND (overall_score < (80)::numeric)) OR ((severity = 'low'::text) AND (overall_score >= (80)::numeric))));
ALTER TABLE public."conversation_evaluation_attempt" ADD CONSTRAINT "conversation_evaluation_attem_evaluation_contract_version_check" CHECK ((length(btrim(evaluation_contract_version)) > 0));
ALTER TABLE public."conversation_evaluation_attempt" ADD CONSTRAINT "conversation_evaluation_attempt_initiated_by_kind_check" CHECK ((initiated_by_kind = ANY (ARRAY['user'::text, 'automation'::text])));
ALTER TABLE public."conversation_evaluation_attempt" ADD CONSTRAINT "conversation_evaluation_attempt_input_snapshot_hash_check" CHECK ((input_snapshot_hash ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE public."conversation_evaluation_attempt" ADD CONSTRAINT "conversation_evaluation_attempt_kb_snapshot_id_check" CHECK ((length(btrim(kb_snapshot_id)) > 0));
ALTER TABLE public."conversation_evaluation_attempt" ADD CONSTRAINT "conversation_evaluation_attempt_model_version_check" CHECK ((length(btrim(model_version)) > 0));
ALTER TABLE public."conversation_evaluation_attempt" ADD CONSTRAINT "conversation_evaluation_attempt_pkey" PRIMARY KEY (id);
ALTER TABLE public."conversation_evaluation_attempt" ADD CONSTRAINT "conversation_evaluation_attempt_policy_snapshot_id_check" CHECK ((length(btrim(policy_snapshot_id)) > 0));
ALTER TABLE public."conversation_evaluation_attempt" ADD CONSTRAINT "conversation_evaluation_attempt_prompt_version_check" CHECK ((length(btrim(prompt_version)) > 0));
ALTER TABLE public."conversation_evaluation_attempt" ADD CONSTRAINT "conversation_evaluation_attempt_source_deployment_check" CHECK ((source_deployment ~ '^[A-Za-z0-9._:-]{1,128}$'::text));
ALTER TABLE public."conversation_evaluation_attempt" ADD CONSTRAINT "conversation_evaluation_attempt_status_check" CHECK ((status = ANY (ARRAY['running'::text, 'complete'::text, 'failed'::text, 'persistence_error'::text])));
ALTER TABLE public."conversations" ADD CONSTRAINT "conversations_pkey" PRIMARY KEY (id);
ALTER TABLE public."conversations" ADD CONSTRAINT "conversations_priority_check" CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text])));
ALTER TABLE public."conversations" ADD CONSTRAINT "conversations_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'pending'::text, 'resolved'::text, 'unresolved'::text, 'transferred'::text])));
ALTER TABLE public."evaluation_training_outbox" ADD CONSTRAINT "evaluation_training_outbox_delivery_idempotency_key_key" UNIQUE (delivery_idempotency_key);
ALTER TABLE public."evaluation_training_outbox" ADD CONSTRAINT "evaluation_training_outbox_evaluation_contract_version_check" CHECK ((length(btrim(evaluation_contract_version)) > 0));
ALTER TABLE public."evaluation_training_outbox" ADD CONSTRAINT "evaluation_training_outbox_pkey" PRIMARY KEY (id);
ALTER TABLE public."evaluation_training_outbox" ADD CONSTRAINT "evaluation_training_outbox_source_deployment_check" CHECK ((source_deployment ~ '^[A-Za-z0-9._:-]{1,128}$'::text));
ALTER TABLE public."evaluation_training_outbox" ADD CONSTRAINT "evaluation_training_outbox_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'delivered'::text, 'failed'::text, 'skipped'::text])));
ALTER TABLE public."feedback_request" ADD CONSTRAINT "feedback_request_delivery_error_type_check" CHECK (((delivery_error_type IS NULL) OR (delivery_error_type = ANY (ARRAY['resend_auth_error'::text, 'resend_validation_error'::text, 'resend_rate_limited'::text, 'email_send_failed'::text, 'config_error'::text, 'missing_recipient_email'::text, 'provider_auth_error'::text, 'provider_validation_error'::text, 'provider_rate_limited'::text, 'provider_send_failed'::text, 'invalid_claim_scope'::text, 'email_provider_not_configured'::text, 'unsupported_feedback_channel'::text, 'delivery_completion_failed'::text]))));
ALTER TABLE public."feedback_request" ADD CONSTRAINT "feedback_request_delivery_status_check" CHECK ((delivery_status = ANY (ARRAY['pending'::text, 'token_generated'::text, 'sent'::text, 'delivery_failed'::text, 'bounced'::text, 'complained'::text])));
ALTER TABLE public."feedback_request" ADD CONSTRAINT "feedback_request_pkey" PRIMARY KEY (id);
ALTER TABLE public."feedback_request" ADD CONSTRAINT "feedback_request_rating_check" CHECK (((rating IS NULL) OR ((rating_type = 'nps'::text) AND ((rating >= 0) AND (rating <= 10))) OR ((rating_type = 'ces'::text) AND ((rating >= 1) AND (rating <= 7))) OR ((rating_type = ANY (ARRAY['stars_1_5'::text, 'csat'::text])) AND ((rating >= 1) AND (rating <= 5))) OR ((rating_type = 'thumbs'::text) AND ((rating >= 0) AND (rating <= 1))) OR ((rating_type = 'survey'::text) AND ((rating >= 1) AND (rating <= 5)))));
ALTER TABLE public."feedback_request" ADD CONSTRAINT "feedback_request_request_type_check" CHECK ((request_type = ANY (ARRAY['csat'::text, 'nps'::text, 'custom'::text])));
ALTER TABLE public."feedback_request" ADD CONSTRAINT "feedback_request_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'responded'::text, 'expired'::text, 'skipped'::text])));
ALTER TABLE public."handoff_event" ADD CONSTRAINT "handoff_event_handoff_type_check" CHECK ((handoff_type = ANY (ARRAY['ai_to_agent'::text, 'agent_to_agent'::text, 'escalation'::text])));
ALTER TABLE public."handoff_event" ADD CONSTRAINT "handoff_event_pkey" PRIMARY KEY (id);
ALTER TABLE public."hf3_learning_case" ADD CONSTRAINT "hf3_learning_case_evaluation_id_key" UNIQUE (evaluation_id);
ALTER TABLE public."hf3_learning_case" ADD CONSTRAINT "hf3_learning_case_feedback_quality_score_check" CHECK (((feedback_quality_score IS NULL) OR ((feedback_quality_score >= (0)::numeric) AND (feedback_quality_score <= (100)::numeric))));
ALTER TABLE public."hf3_learning_case" ADD CONSTRAINT "hf3_learning_case_handoff_classification_check" CHECK ((handoff_classification = ANY (ARRAY['not_applicable'::text, 'unavoidable'::text, 'potentially_avoidable'::text, 'unknown'::text])));
ALTER TABLE public."hf3_learning_case" ADD CONSTRAINT "hf3_learning_case_learning_state_check" CHECK ((learning_state = ANY (ARRAY['observed'::text, 'candidate'::text, 'queued'::text, 'delivered'::text, 'trained'::text, 'kb_pending'::text, 'kb_published'::text, 'closed'::text])));
ALTER TABLE public."hf3_learning_case" ADD CONSTRAINT "hf3_learning_case_pkey" PRIMARY KEY (id);
ALTER TABLE public."human_support_queue" ADD CONSTRAINT "human_support_queue_pkey" PRIMARY KEY (conversation_id);
ALTER TABLE public."human_support_queue" ADD CONSTRAINT "human_support_queue_priority_check" CHECK (((priority >= 0) AND (priority <= 1000)));
ALTER TABLE public."human_support_queue" ADD CONSTRAINT "human_support_queue_state_check" CHECK ((state = ANY (ARRAY['waiting'::text, 'assigned'::text, 'closed'::text])));
ALTER TABLE public."messages" ADD CONSTRAINT "messages_content_type_check" CHECK ((content_type = ANY (ARRAY['text'::text, 'image'::text, 'video'::text, 'file'::text, 'quick_reply'::text])));
ALTER TABLE public."messages" ADD CONSTRAINT "messages_pkey" PRIMARY KEY (id);
ALTER TABLE public."messages" ADD CONSTRAINT "messages_role_check" CHECK ((role = ANY (ARRAY['visitor'::text, 'assistant'::text, 'agent'::text, 'system'::text])));
ALTER TABLE public."messages" ADD CONSTRAINT "messages_status_check" CHECK ((status = ANY (ARRAY['sending'::text, 'delivered'::text, 'read'::text, 'recalled'::text, 'failed'::text])));
ALTER TABLE public."user_roles" ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY (id);
ALTER TABLE public."user_roles" ADD CONSTRAINT "user_roles_user_id_unique" UNIQUE (user_id);
ALTER TABLE public."visitor_session" ADD CONSTRAINT "visitor_session_pkey" PRIMARY KEY (id);
ALTER TABLE public."visitor_session" ADD CONSTRAINT "visitor_session_session_token_key" UNIQUE (session_token);
ALTER TABLE public."widget_config" ADD CONSTRAINT "widget_config_appearance_theme_check" CHECK ((appearance_theme = ANY (ARRAY['classic'::text, 'modern'::text])));
ALTER TABLE public."widget_config" ADD CONSTRAINT "widget_config_launcher_icon_check" CHECK ((launcher_icon = ANY (ARRAY['chat'::text, 'headset'::text, 'sparkles'::text, 'bot'::text, 'mail'::text])));
ALTER TABLE public."widget_config" ADD CONSTRAINT "widget_config_pkey" PRIMARY KEY (id);
ALTER TABLE public."ce_automation_runtime" ADD CONSTRAINT "ce_automation_runtime_background_sweep_minutes_check" CHECK (((background_sweep_minutes >= 5) AND (background_sweep_minutes <= 1440)));
ALTER TABLE public."ce_automation_runtime" ADD CONSTRAINT "ce_automation_runtime_debounce_minutes_check" CHECK (((debounce_minutes >= 1) AND (debounce_minutes <= 120)));
ALTER TABLE public."ce_automation_runtime" ADD CONSTRAINT "ce_automation_runtime_enqueue_batch_limit_check" CHECK (((enqueue_batch_limit >= 1) AND (enqueue_batch_limit <= 1000)));
ALTER TABLE public."ce_automation_runtime" ADD CONSTRAINT "ce_automation_runtime_global_concurrency_check" CHECK (((global_concurrency >= 1) AND (global_concurrency <= 20)));
ALTER TABLE public."ce_automation_runtime" ADD CONSTRAINT "ce_automation_runtime_max_age_minutes_check" CHECK (((max_age_minutes >= 30) AND (max_age_minutes <= 1440)));
ALTER TABLE public."ce_automation_runtime" ADD CONSTRAINT "ce_automation_runtime_per_company_concurrency_check" CHECK (((per_company_concurrency >= 1) AND (per_company_concurrency <= 10)));
ALTER TABLE public."ce_automation_runtime" ADD CONSTRAINT "ce_automation_runtime_pkey" PRIMARY KEY (singleton);
ALTER TABLE public."ce_automation_runtime" ADD CONSTRAINT "ce_automation_runtime_singleton_check" CHECK (singleton);
ALTER TABLE public."ce_automation_runtime" ADD CONSTRAINT "ce_automation_runtime_worker_token_hash_check" CHECK (((worker_token_hash IS NULL) OR (worker_token_hash ~ '^[0-9a-f]{64}$'::text)));
ALTER TABLE public."conversation_commerce_state" ADD CONSTRAINT "conversation_commerce_state_conversation_company_unique" UNIQUE (conversation_id, company_id);
ALTER TABLE public."conversation_commerce_state" ADD CONSTRAINT "conversation_commerce_state_hash_check" CHECK ((state_hash ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE public."conversation_commerce_state" ADD CONSTRAINT "conversation_commerce_state_object_check" CHECK ((jsonb_typeof(state) = 'object'::text));
ALTER TABLE public."conversation_commerce_state" ADD CONSTRAINT "conversation_commerce_state_pkey" PRIMARY KEY (conversation_id);
ALTER TABLE public."conversation_commerce_state" ADD CONSTRAINT "conversation_commerce_state_revision_check" CHECK ((revision >= 1));
ALTER TABLE public."conversation_commerce_state" ADD CONSTRAINT "conversation_commerce_state_version_check" CHECK (((state ->> 'version'::text) = 'commerce-state-1.0.0'::text));
ALTER TABLE public."conversation_memory_state" ADD CONSTRAINT "conversation_memory_state_company_unique" UNIQUE (conversation_id, company_id);
ALTER TABLE public."conversation_memory_state" ADD CONSTRAINT "conversation_memory_state_hash_check" CHECK ((memory_hash ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE public."conversation_memory_state" ADD CONSTRAINT "conversation_memory_state_object_check" CHECK ((jsonb_typeof(memory) = 'object'::text));
ALTER TABLE public."conversation_memory_state" ADD CONSTRAINT "conversation_memory_state_pkey" PRIMARY KEY (conversation_id);
ALTER TABLE public."conversation_memory_state" ADD CONSTRAINT "conversation_memory_state_projection_size_check" CHECK ((octet_length(markdown_projection) <= 32768));
ALTER TABLE public."conversation_memory_state" ADD CONSTRAINT "conversation_memory_state_revision_check" CHECK ((revision >= 1));
ALTER TABLE public."conversation_memory_state" ADD CONSTRAINT "conversation_memory_state_size_check" CHECK ((octet_length((memory)::text) <= 65536));
ALTER TABLE public."conversation_memory_state" ADD CONSTRAINT "conversation_memory_state_updated_from_turn_check" CHECK ((updated_from_turn >= 0));
ALTER TABLE public."conversation_memory_state" ADD CONSTRAINT "conversation_memory_state_version_check" CHECK (((memory ->> 'version'::text) = 'conversation-memory-1.0.0'::text));
ALTER TABLE public."ce_bundle_snapshot" ADD CONSTRAINT "ce_bundle_snapshot_attempt_id_fkey" FOREIGN KEY (attempt_id) REFERENCES conversation_evaluation_attempt(id) ON DELETE CASCADE;
ALTER TABLE public."ce_discrepancy" ADD CONSTRAINT "ce_discrepancy_evaluation_id_fkey" FOREIGN KEY (evaluation_id) REFERENCES conversation_evaluation(id) ON DELETE CASCADE;
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_evaluation_job_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public."ce_evaluation_job" ADD CONSTRAINT "ce_job_conversation_company_fkey" FOREIGN KEY (conversation_id, company_id) REFERENCES conversations(id, company_id);
ALTER TABLE public."ce_evaluation_state" ADD CONSTRAINT "ce_evaluation_state_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public."ce_evaluation_state" ADD CONSTRAINT "ce_state_conversation_company_fkey" FOREIGN KEY (conversation_id, company_id) REFERENCES conversations(id, company_id);
ALTER TABLE public."ce_kb_publish_state" ADD CONSTRAINT "ce_kb_publish_state_evaluation_company_fkey" FOREIGN KEY (evaluation_id, company_id) REFERENCES conversation_evaluation(id, company_id) ON DELETE CASCADE;
ALTER TABLE public."ce_kb_publish_state" ADD CONSTRAINT "ce_kb_publish_state_evaluation_id_fkey" FOREIGN KEY (evaluation_id) REFERENCES conversation_evaluation(id) ON DELETE CASCADE;
ALTER TABLE public."ce_local_evaluation_attempt" ADD CONSTRAINT "ce_local_evaluation_attempt_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public."ce_training_link" ADD CONSTRAINT "ce_training_link_evaluation_company_fkey" FOREIGN KEY (evaluation_id, company_id) REFERENCES conversation_evaluation(id, company_id) ON DELETE CASCADE;
ALTER TABLE public."ce_training_link" ADD CONSTRAINT "ce_training_link_evaluation_id_fkey" FOREIGN KEY (evaluation_id) REFERENCES conversation_evaluation(id) ON DELETE CASCADE;
ALTER TABLE public."channel_config" ADD CONSTRAINT "channel_config_company_id_fkey" FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE public."channel_config" ADD CONSTRAINT "channel_config_widget_config_id_fkey" FOREIGN KEY (widget_config_id) REFERENCES widget_config(id);
ALTER TABLE public."company_membership" ADD CONSTRAINT "company_membership_company_id_fkey" FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE;
ALTER TABLE public."company_membership" ADD CONSTRAINT "company_membership_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public."conversation_assignment" ADD CONSTRAINT "conversation_assignment_agent_id_fkey" FOREIGN KEY (agent_id) REFERENCES agent_profile(id);
ALTER TABLE public."conversation_assignment" ADD CONSTRAINT "conversation_assignment_assigned_by_fkey" FOREIGN KEY (assigned_by) REFERENCES agent_profile(id);
ALTER TABLE public."conversation_assignment" ADD CONSTRAINT "conversation_assignment_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "ce_evaluation_attempt_lineage_fkey" FOREIGN KEY (attempt_id, conversation_id, company_id) REFERENCES conversation_evaluation_attempt(id, conversation_id, company_id);
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_attempt_id_fkey" FOREIGN KEY (attempt_id) REFERENCES conversation_evaluation_attempt(id);
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_company_id_fkey" FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE public."conversation_evaluation" ADD CONSTRAINT "conversation_evaluation_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id);
ALTER TABLE public."conversation_evaluation_attempt" ADD CONSTRAINT "ce_attempt_conversation_company_fkey" FOREIGN KEY (conversation_id, company_id) REFERENCES conversations(id, company_id);
ALTER TABLE public."conversation_evaluation_attempt" ADD CONSTRAINT "conversation_evaluation_attempt_company_id_fkey" FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE public."conversation_evaluation_attempt" ADD CONSTRAINT "conversation_evaluation_attempt_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id);
ALTER TABLE public."conversations" ADD CONSTRAINT "conversations_channel_config_id_fkey" FOREIGN KEY (channel_config_id) REFERENCES channel_config(id);
ALTER TABLE public."conversations" ADD CONSTRAINT "conversations_company_id_fkey" FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE public."conversations" ADD CONSTRAINT "conversations_visitor_session_id_fkey" FOREIGN KEY (visitor_session_id) REFERENCES visitor_session(id);
ALTER TABLE public."evaluation_training_outbox" ADD CONSTRAINT "ce_outbox_evaluation_company_fkey" FOREIGN KEY (evaluation_id, company_id) REFERENCES conversation_evaluation(id, company_id);
ALTER TABLE public."evaluation_training_outbox" ADD CONSTRAINT "evaluation_training_outbox_company_id_fkey" FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE public."evaluation_training_outbox" ADD CONSTRAINT "evaluation_training_outbox_evaluation_id_fkey" FOREIGN KEY (evaluation_id) REFERENCES conversation_evaluation(id);
ALTER TABLE public."feedback_request" ADD CONSTRAINT "feedback_request_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public."feedback_request" ADD CONSTRAINT "feedback_request_visitor_session_id_fkey" FOREIGN KEY (visitor_session_id) REFERENCES visitor_session(id);
ALTER TABLE public."handoff_event" ADD CONSTRAINT "handoff_event_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public."human_support_queue" ADD CONSTRAINT "human_support_queue_assigned_agent_id_fkey" FOREIGN KEY (assigned_agent_id) REFERENCES agent_profile(id) ON DELETE SET NULL;
ALTER TABLE public."human_support_queue" ADD CONSTRAINT "human_support_queue_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public."messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public."messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY (sender_id) REFERENCES agent_profile(id);
ALTER TABLE public."user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public."visitor_session" ADD CONSTRAINT "visitor_session_channel_config_id_fkey" FOREIGN KEY (channel_config_id) REFERENCES channel_config(id);
ALTER TABLE public."conversation_commerce_state" ADD CONSTRAINT "conversation_commerce_state_company_id_fkey" FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE;
ALTER TABLE public."conversation_commerce_state" ADD CONSTRAINT "conversation_commerce_state_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public."conversation_commerce_state" ADD CONSTRAINT "conversation_commerce_state_source_message_id_fkey" FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE RESTRICT;
ALTER TABLE public."conversation_memory_state" ADD CONSTRAINT "conversation_memory_state_company_id_fkey" FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE;
ALTER TABLE public."conversation_memory_state" ADD CONSTRAINT "conversation_memory_state_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public."conversation_memory_state" ADD CONSTRAINT "conversation_memory_state_source_message_id_fkey" FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE RESTRICT;
CREATE INDEX idx_bundle_snapshot_conversation ON public.ce_bundle_snapshot USING btree (conversation_id, created_at DESC);
CREATE INDEX idx_bundle_snapshot_retention ON public.ce_bundle_snapshot USING btree (retention_expires_at);
CREATE INDEX idx_ce_discrepancy_eval ON public.ce_discrepancy USING btree (evaluation_id);
CREATE INDEX ce_evaluation_job_company_running_idx ON public.ce_evaluation_job USING btree (company_id, status) WHERE (status = 'running'::text);
CREATE INDEX ce_evaluation_job_ready_idx ON public.ce_evaluation_job USING btree (status, available_at, priority DESC, created_at) WHERE (status = 'queued'::text);
CREATE UNIQUE INDEX ce_evaluation_methodology_one_current_idx ON public.ce_evaluation_methodology USING btree (status) WHERE (status = 'current'::text);
CREATE INDEX ce_evaluation_state_company_state_idx ON public.ce_evaluation_state USING btree (company_id, state, last_activity_at);
CREATE INDEX ce_evaluation_state_dirty_idx ON public.ce_evaluation_state USING btree (dirty_since, last_activity_at) WHERE (state = ANY (ARRAY['never_evaluated'::text, 'dirty'::text, 'failed'::text, 'stale_version'::text]));
CREATE INDEX idx_ce_kb_publish_state_eval ON public.ce_kb_publish_state USING btree (evaluation_id);
CREATE UNIQUE INDEX uq_ce_kb_publish_state_eval_action ON public.ce_kb_publish_state USING btree (evaluation_id, action);
CREATE UNIQUE INDEX ce_local_attempt_snapshot_fingerprint_uidx ON public.ce_local_evaluation_attempt USING btree (conversation_id, input_snapshot_hash, evaluation_fingerprint) WHERE (evaluation_fingerprint IS NOT NULL);
CREATE INDEX idx_ce_training_link_eval ON public.ce_training_link USING btree (evaluation_id);
CREATE UNIQUE INDEX uq_company_platform_company_id ON public.company USING btree (platform_company_id);
CREATE UNIQUE INDEX company_platform_company_id_uq ON public.company USING btree (platform_company_id);
CREATE INDEX idx_company_membership_user ON public.company_membership USING btree (user_id) WHERE is_active;
CREATE UNIQUE INDEX uq_company_membership_company_user ON public.company_membership USING btree (company_id, user_id);
CREATE UNIQUE INDEX conversation_assignment_one_active ON public.conversation_assignment USING btree (conversation_id) WHERE (is_active = true);
CREATE UNIQUE INDEX ce_canonical_snapshot_fingerprint_uidx ON public.conversation_evaluation USING btree (conversation_id, evaluation_contract_version, input_snapshot_hash, evaluation_fingerprint) WHERE (evaluation_fingerprint IS NOT NULL);
CREATE INDEX conversation_evaluation_current_idx ON public.conversation_evaluation USING btree (conversation_id, created_at DESC) WHERE (freshness = 'current'::text);
CREATE INDEX idx_ce_company_created ON public.conversation_evaluation USING btree (company_id, created_at DESC);
CREATE INDEX idx_ce_review_status_created ON public.conversation_evaluation USING btree (review_status, created_at DESC);
CREATE UNIQUE INDEX ce_evaluation_id_company_uq ON public.conversation_evaluation USING btree (id, company_id);
CREATE UNIQUE INDEX uq_attempt_running ON public.conversation_evaluation_attempt USING btree (conversation_id, evaluation_contract_version, input_snapshot_hash) WHERE (status = 'running'::text);
CREATE UNIQUE INDEX ce_attempt_id_conversation_company_uq ON public.conversation_evaluation_attempt USING btree (id, conversation_id, company_id);
CREATE INDEX idx_conversations_channel ON public.conversations USING btree (channel_config_id);
CREATE INDEX idx_conversations_company ON public.conversations USING btree (company_id);
CREATE INDEX idx_conversations_visitor_session ON public.conversations USING btree (visitor_session_id);
CREATE UNIQUE INDEX conversations_id_company_id_uq ON public.conversations USING btree (id, company_id);
CREATE UNIQUE INDEX uq_evaluation_training_outbox_evaluation_id ON public.evaluation_training_outbox USING btree (evaluation_id);
CREATE UNIQUE INDEX idx_feedback_request_response_token_hash ON public.feedback_request USING btree (response_token_hash) WHERE (response_token_hash IS NOT NULL);
CREATE INDEX idx_hf3_learning_case_company_intent ON public.hf3_learning_case USING btree (company_id, intent_key, created_at DESC);
CREATE INDEX idx_hf3_learning_case_candidate ON public.hf3_learning_case USING btree (company_id, training_candidate, learning_state, created_at DESC);
CREATE INDEX human_support_queue_company_wait_idx ON public.human_support_queue USING btree (company_id, state, priority, queued_at, conversation_id);
CREATE INDEX idx_messages_conversation_time ON public.messages USING btree (conversation_id, created_at);
CREATE INDEX idx_messages_sender_id ON public.messages USING btree (sender_id) WHERE (sender_id IS NOT NULL);
CREATE INDEX idx_messages_thinking_sentinel ON public.messages USING btree (conversation_id, content) WHERE (content = '__THINKING__'::text);
CREATE UNIQUE INDEX messages_widget_client_message_id_uq ON public.messages USING btree (conversation_id, ((metadata ->> 'client_message_id'::text))) WHERE ((role = 'visitor'::text) AND (COALESCE((metadata ->> 'client_message_id'::text), ''::text) <> ''::text) AND (COALESCE(is_recalled, false) = false));
CREATE INDEX idx_visitor_session_token ON public.visitor_session USING btree (session_token);
CREATE OR REPLACE FUNCTION public.ce_trigger_snapshot_hash_v1(p_conversation_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ SELECT encode(extensions.digest(convert_to(COALESCE(string_agg(m.id::text||'|'||lower(COALESCE(m.role,''))||'|'||COALESCE(m.content,'')||'|'||COALESCE(m.is_recalled,false)::text||'|'||COALESCE(m.sender_id::text,'')||'|'||COALESCE(m.sender_identity_verified_at::text,''),E'\n' ORDER BY m.created_at,m.id),'')||E'\n','UTF8'),'sha256'),'hex') FROM public.messages m WHERE m.conversation_id=p_conversation_id AND COALESCE(m.content,'') IS DISTINCT FROM '__THINKING__' $function$;
CREATE OR REPLACE FUNCTION public.ce_current_evaluation_fingerprint()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ SELECT m.evaluation_fingerprint FROM public.ce_evaluation_methodology m WHERE m.status='current' LIMIT 1 $function$;
CREATE OR REPLACE FUNCTION public.ce_runtime_conversation_company(p_conversation_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ SELECT COALESCE(c.company_id,cc.company_id) FROM public.conversations c LEFT JOIN public.channel_config cc ON cc.id=c.channel_config_id WHERE c.id=p_conversation_id $function$;
CREATE OR REPLACE FUNCTION public.check_conv_assignment_invariant(p_conv_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$ DECLARE v_assigned uuid;v_found boolean;v_active_count int;v_active_agent uuid;BEGIN SELECT true,assigned_agent_id INTO v_found,v_assigned FROM public.conversations WHERE id=p_conv_id;IF v_found IS NULL THEN RAISE EXCEPTION 'ASSIGNMENT_INVARIANT: conversation % not found',p_conv_id;END IF;SELECT count(*) INTO v_active_count FROM public.conversation_assignment WHERE conversation_id=p_conv_id AND is_active=true;v_active_agent:=NULL;IF v_active_count=1 THEN SELECT agent_id INTO v_active_agent FROM public.conversation_assignment WHERE conversation_id=p_conv_id AND is_active=true;END IF;IF v_assigned IS NULL THEN IF v_active_count>0 THEN RAISE EXCEPTION 'ASSIGNMENT_INVARIANT: unassigned conv % has % active',p_conv_id,v_active_count;END IF;ELSE IF v_active_count!=1 THEN RAISE EXCEPTION 'ASSIGNMENT_INVARIANT: assigned conv % has % active (expected 1)',p_conv_id,v_active_count;END IF;IF v_active_agent IS DISTINCT FROM v_assigned THEN RAISE EXCEPTION 'ASSIGNMENT_INVARIANT: conv % agent mismatch: assignment=% conv=%',p_conv_id,v_active_agent,v_assigned;END IF;END IF;END;$function$;
CREATE OR REPLACE FUNCTION public.trg_check_conversation_side()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$ BEGIN IF OLD.assigned_agent_id IS DISTINCT FROM NEW.assigned_agent_id THEN PERFORM public.check_conv_assignment_invariant(NEW.id);END IF;RETURN NULL;END;$function$;
CREATE OR REPLACE FUNCTION public._ce_enforce_conversation_company()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_owner_text text;
BEGIN
  IF NEW.company_id IS NULL THEN
    SELECT cc.company_id INTO NEW.company_id FROM public.channel_config cc WHERE cc.id = NEW.channel_config_id;
  END IF;
  IF NEW.company_id IS NULL THEN
    v_owner_text := COALESCE(NEW.metadata_source->>'owner_user_id','');
    IF NOT (NEW.channel_config_id IS NULL AND COALESCE(NEW.metadata_source->>'source','') = 'widget_live_test' AND COALESCE((NEW.metadata_source->>'widget_live_test')::boolean,false) = true AND COALESCE((NEW.metadata_source->>'exclude_training')::boolean,false) = true AND v_owner_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = v_owner_text::uuid AND ur.role::text IN ('admin','supervisor')) AND NOT EXISTS (SELECT 1 FROM public.company_membership cm WHERE cm.user_id = v_owner_text::uuid)) THEN
      RAISE EXCEPTION 'TENANT_UNRESOLVED: conversation requires company_id (channel_config %)', NEW.channel_config_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.company_id IS NOT NULL AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'TENANT_REASSIGNMENT: conversation company_id cannot change from % to %', OLD.company_id, NEW.company_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.channel_config_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.channel_config cc WHERE cc.id = NEW.channel_config_id AND cc.company_id IS NOT NULL AND cc.company_id IS DISTINCT FROM NEW.company_id) THEN
      RAISE EXCEPTION 'TENANT_CHANNEL_MISMATCH: conversation.company_id % vs channel_config.company_id', NEW.company_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.pr7_ce_canonical_company(p_conversation_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ DECLARE v_conv_company uuid;v_channel_company uuid;v_company uuid;BEGIN SELECT c.company_id,ch.company_id INTO v_conv_company,v_channel_company FROM public.conversations c LEFT JOIN public.channel_config ch ON ch.id=c.channel_config_id WHERE c.id=p_conversation_id;IF NOT FOUND THEN RAISE EXCEPTION 'CE_LINEAGE_CONVERSATION_NOT_FOUND' USING ERRCODE='foreign_key_violation';END IF;IF v_conv_company IS NOT NULL AND v_channel_company IS NOT NULL AND v_conv_company<>v_channel_company THEN RAISE EXCEPTION 'CE_LINEAGE_TENANT_IDENTITY_CONFLICT' USING ERRCODE='check_violation';END IF;v_company:=COALESCE(v_conv_company,v_channel_company);IF v_company IS NULL THEN RAISE EXCEPTION 'CE_LINEAGE_TENANT_UNRESOLVED' USING ERRCODE='check_violation';END IF;IF NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=v_company AND c.is_active=true) THEN RAISE EXCEPTION 'CE_LINEAGE_COMPANY_INACTIVE' USING ERRCODE='check_violation';END IF;RETURN v_company;END;$function$;
CREATE OR REPLACE FUNCTION public.ce_conversation_evaluable_v1(p_conversation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = p_conversation_id AND COALESCE(c.metadata_source->>'source','') = 'widget_live_test' AND COALESCE((c.metadata_source->>'widget_live_test')::boolean,false) = true AND COALESCE((c.metadata_source->>'exclude_training')::boolean,false) = true) THEN false ELSE (count(*) FILTER (WHERE NOT COALESCE(m.is_recalled,false) AND lower(m.role) IN ('visitor','customer','user')) > 0 AND count(*) FILTER (WHERE NOT COALESCE(m.is_recalled,false) AND lower(m.role) IN ('assistant','ai','bot')) > 0) END FROM public.messages m WHERE m.conversation_id = p_conversation_id AND COALESCE(m.content,'') IS DISTINCT FROM '__THINKING__'
$function$;
CREATE OR REPLACE FUNCTION public.ce_copy_evaluation_fingerprint_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ BEGIN IF NEW.evaluation_fingerprint IS NULL THEN IF TG_TABLE_NAME='conversation_evaluation' THEN SELECT a.evaluation_fingerprint INTO NEW.evaluation_fingerprint FROM public.conversation_evaluation_attempt a WHERE a.id=NEW.attempt_id;ELSE SELECT a.evaluation_fingerprint INTO NEW.evaluation_fingerprint FROM public.ce_local_evaluation_attempt a WHERE a.id=NEW.attempt_id;END IF;END IF;RETURN NEW;END;$function$;
CREATE OR REPLACE FUNCTION public.pr7_ce_guard_evaluation_lineage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ DECLARE v_company uuid;v_attempt record;BEGIN v_company:=public.pr7_ce_canonical_company(NEW.conversation_id);IF NEW.company_id IS NULL OR NEW.company_id<>v_company THEN RAISE EXCEPTION 'CE_LINEAGE_EVALUATION_COMPANY_MISMATCH' USING ERRCODE='check_violation';END IF;SELECT id,conversation_id,company_id,bundle_hash,evaluation_contract_version INTO v_attempt FROM public.conversation_evaluation_attempt WHERE id=NEW.attempt_id;IF v_attempt IS NULL OR v_attempt.conversation_id<>NEW.conversation_id OR v_attempt.company_id IS NULL OR v_attempt.company_id<>v_company OR v_attempt.bundle_hash IS DISTINCT FROM NEW.bundle_hash OR v_attempt.evaluation_contract_version IS DISTINCT FROM NEW.evaluation_contract_version THEN RAISE EXCEPTION 'CE_LINEAGE_ATTEMPT_EVALUATION_MISMATCH' USING ERRCODE='check_violation';END IF;RETURN NEW;END;$function$;
CREATE OR REPLACE FUNCTION public.pr7_ce_guard_outbox_lineage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ DECLARE v_eval record;v_company uuid;BEGIN SELECT id,conversation_id,company_id,evaluation_contract_version,source_deployment INTO v_eval FROM public.conversation_evaluation WHERE id=NEW.evaluation_id;IF v_eval IS NULL THEN RAISE EXCEPTION 'CE_LINEAGE_OUTBOX_EVALUATION_NOT_FOUND' USING ERRCODE='foreign_key_violation';END IF;v_company:=public.pr7_ce_canonical_company(v_eval.conversation_id);IF NEW.company_id IS NULL OR NEW.company_id<>v_company OR v_eval.company_id IS NULL OR v_eval.company_id<>v_company OR NEW.evaluation_contract_version IS DISTINCT FROM v_eval.evaluation_contract_version OR NEW.source_deployment IS DISTINCT FROM v_eval.source_deployment THEN RAISE EXCEPTION 'CE_LINEAGE_OUTBOX_MISMATCH' USING ERRCODE='check_violation';END IF;RETURN NEW;END;$function$;
CREATE OR REPLACE FUNCTION public.ce_mark_evaluation_dirty(p_conversation_id uuid, p_activity_at timestamp with time zone DEFAULT now())
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ DECLARE v_company uuid;BEGIN IF p_conversation_id IS NULL THEN RETURN;END IF;IF NOT EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=p_conversation_id) THEN RETURN;END IF;IF EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=p_conversation_id AND COALESCE(c.metadata_source->>'source','')='widget_live_test' AND COALESCE((c.metadata_source->>'widget_live_test')::boolean,false)=true AND COALESCE((c.metadata_source->>'exclude_training')::boolean,false)=true) THEN RETURN;END IF;v_company:=public.ce_runtime_conversation_company(p_conversation_id);INSERT INTO public.ce_evaluation_state(conversation_id,company_id,state,revision,dirty_since,last_activity_at,updated_at) VALUES(p_conversation_id,v_company,'never_evaluated',1,now(),COALESCE(p_activity_at,now()),now()) ON CONFLICT(conversation_id) DO UPDATE SET company_id=EXCLUDED.company_id,revision=public.ce_evaluation_state.revision+1,state=CASE WHEN public.ce_evaluation_state.last_success_evaluation_id IS NULL THEN 'never_evaluated' ELSE 'dirty' END,dirty_since=COALESCE(public.ce_evaluation_state.dirty_since,now()),last_activity_at=GREATEST(COALESCE(public.ce_evaluation_state.last_activity_at,'-infinity'::timestamptz),COALESCE(EXCLUDED.last_activity_at,now())),queued_at=NULL,evaluating_started_at=NULL,last_error_code=NULL,updated_at=now();END;$function$;
CREATE OR REPLACE FUNCTION public.ce_enqueue_evaluation_v1(p_conversation_id uuid, p_snapshot_hash text, p_evaluation_fingerprint text, p_expected_revision bigint, p_source text, p_available_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ DECLARE v_company uuid;v_state public.ce_evaluation_state;v_job public.ce_evaluation_job;v_job_id uuid;v_job_key text;v_priority integer;v_current_fingerprint text;v_interactive boolean;BEGIN IF p_conversation_id IS NULL OR NULLIF(trim(COALESCE(p_snapshot_hash,'')),'') IS NULL OR COALESCE(p_evaluation_fingerprint,'')!~'^[0-9a-f]{64}$' OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_source NOT IN('scheduler','ce_dwell','resolved','verified_correction','manual','max_age') THEN RETURN jsonb_build_object('result','invalid_input');END IF;v_current_fingerprint:=public.ce_current_evaluation_fingerprint();IF v_current_fingerprint IS NULL THEN RETURN jsonb_build_object('result','methodology_not_configured');END IF;IF p_evaluation_fingerprint IS DISTINCT FROM v_current_fingerprint THEN RETURN jsonb_build_object('result','fingerprint_not_current');END IF;SELECT * INTO v_state FROM public.ce_evaluation_state WHERE conversation_id=p_conversation_id FOR UPDATE;IF v_state.conversation_id IS NULL THEN RETURN jsonb_build_object('result','state_not_initialized');END IF;IF v_state.revision IS DISTINCT FROM p_expected_revision THEN RETURN jsonb_build_object('result','stale_revision','current_revision',v_state.revision);END IF;v_company:=public.ce_runtime_conversation_company(p_conversation_id);v_priority:=CASE p_source WHEN 'manual' THEN 100 WHEN 'verified_correction' THEN 90 WHEN 'resolved' THEN 80 WHEN 'ce_dwell' THEN 70 WHEN 'max_age' THEN 60 ELSE 50 END;v_interactive:=p_source IN('manual','ce_dwell','resolved','verified_correction');v_job_key:=encode(extensions.digest(convert_to(p_conversation_id::text||'|'||p_snapshot_hash||'|'||p_evaluation_fingerprint,'UTF8'),'sha256'),'hex');INSERT INTO public.ce_evaluation_job(job_key,conversation_id,company_id,snapshot_hash,evaluation_fingerprint,expected_revision,source,priority,status,available_at,updated_at) VALUES(v_job_key,p_conversation_id,v_company,p_snapshot_hash,p_evaluation_fingerprint,p_expected_revision,p_source,v_priority,'queued',COALESCE(p_available_at,now()),now()) ON CONFLICT(job_key) DO NOTHING RETURNING id INTO v_job_id;IF v_job_id IS NULL THEN SELECT * INTO v_job FROM public.ce_evaluation_job WHERE job_key=v_job_key FOR UPDATE;IF v_job.id IS NULL THEN RETURN jsonb_build_object('result','job_lookup_failed');END IF;IF v_interactive AND v_job.status IN('cancelled','failed') THEN UPDATE public.ce_evaluation_job SET company_id=v_company,expected_revision=p_expected_revision,source=p_source,priority=v_priority,status='queued',available_at=COALESCE(p_available_at,now()),attempts=0,lease_owner=NULL,lease_expires_at=NULL,started_at=NULL,finished_at=NULL,error_code=NULL,updated_at=now() WHERE id=v_job.id RETURNING id INTO v_job_id;ELSE RETURN jsonb_build_object('result',CASE WHEN v_job.status='succeeded' THEN 'already_succeeded' WHEN v_job.status='running' THEN 'already_running' WHEN v_job.status='queued' THEN 'already_queued' ELSE 'terminal_job' END,'job_id',v_job.id,'job_key',v_job_key,'job_status',v_job.status);END IF;END IF;UPDATE public.ce_evaluation_state SET state='queued',company_id=v_company,current_snapshot_hash=p_snapshot_hash,current_evaluation_fingerprint=p_evaluation_fingerprint,queued_at=now(),last_error_code=NULL,updated_at=now() WHERE conversation_id=p_conversation_id AND revision=p_expected_revision;RETURN jsonb_build_object('result','queued','job_id',v_job_id,'job_key',v_job_key,'priority',v_priority);END;$function$;
CREATE OR REPLACE FUNCTION public.ce_enqueue_current_snapshot_v1(p_conversation_id uuid, p_source text, p_available_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ DECLARE v_state public.ce_evaluation_state;v_hash text;v_fingerprint text;v_result jsonb;BEGIN IF p_source NOT IN('scheduler','ce_dwell','resolved','verified_correction','manual','max_age') THEN RETURN jsonb_build_object('result','invalid_source');END IF;IF NOT public.ce_conversation_evaluable_v1(p_conversation_id) THEN RETURN jsonb_build_object('result','conversation_not_evaluable');END IF;v_fingerprint:=public.ce_current_evaluation_fingerprint();IF v_fingerprint IS NULL THEN RETURN jsonb_build_object('result','methodology_not_configured');END IF;SELECT * INTO v_state FROM public.ce_evaluation_state WHERE conversation_id=p_conversation_id FOR UPDATE;IF v_state.conversation_id IS NULL THEN RETURN jsonb_build_object('result','state_not_initialized');END IF;v_hash:=public.ce_trigger_snapshot_hash_v1(p_conversation_id);IF v_state.last_success_snapshot_hash IS NOT DISTINCT FROM v_hash AND v_state.last_success_fingerprint IS NOT DISTINCT FROM v_fingerprint AND v_state.state='up_to_date' THEN RETURN jsonb_build_object('result','up_to_date','snapshot_hash',v_hash,'evaluation_fingerprint',v_fingerprint);END IF;v_result:=public.ce_enqueue_evaluation_v1(p_conversation_id,v_hash,v_fingerprint,v_state.revision,p_source,COALESCE(p_available_at,now()));RETURN v_result||jsonb_build_object('snapshot_hash',v_hash,'evaluation_fingerprint',v_fingerprint,'expected_revision',v_state.revision);END;$function$;
CREATE OR REPLACE FUNCTION public.ce_resolved_priority_trigger_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ BEGIN IF (NEW.status IS DISTINCT FROM OLD.status AND lower(COALESCE(NEW.status,''))='resolved') OR (NEW.resolved_at IS DISTINCT FROM OLD.resolved_at AND NEW.resolved_at IS NOT NULL) THEN PERFORM public.ce_mark_evaluation_dirty(NEW.id,now());PERFORM public.ce_enqueue_current_snapshot_v1(NEW.id,'resolved',now());END IF;RETURN NEW;END;$function$;
CREATE OR REPLACE FUNCTION public.pr6_enqueue_canonical_evaluation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.id IS NULL OR NEW.company_id IS NULL OR NEW.conversation_id IS NULL
     OR NEW.evaluation_contract_version IS NULL OR NEW.source_deployment IS NULL THEN
    RAISE EXCEPTION 'PR6_OUTBOX_SCOPE_INVALID' USING ERRCODE='check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.conversation_evaluation_attempt a
      JOIN public.ce_bundle_snapshot s ON s.attempt_id = a.id
     WHERE a.id = NEW.attempt_id
       AND a.conversation_id = NEW.conversation_id
       AND a.company_id = NEW.company_id
       AND a.status IN ('running','complete')
       AND s.conversation_id = NEW.conversation_id
       AND s.company_id = NEW.company_id
       AND s.bundle_hash = NEW.bundle_hash
       AND s.evaluation_contract_version = NEW.evaluation_contract_version
  ) THEN
    RAISE EXCEPTION 'PR6_CANONICAL_SNAPSHOT_MISSING' USING ERRCODE='check_violation';
  END IF;

  IF NEW.training_eligible AND NEW.review_status = 'accepted' THEN
    INSERT INTO public.evaluation_training_outbox(
      evaluation_id,status,delivery_idempotency_key,source_app,
      source_deployment,evaluation_contract_version,company_id
    ) VALUES (
      NEW.id,'pending',NEW.id::text,'ai_chatbot',
      NEW.source_deployment,NEW.evaluation_contract_version,NEW.company_id
    ) ON CONFLICT(evaluation_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.task22_fill_hallucination_quality_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.hallucination_quality_score IS NULL THEN
    NEW.hallucination_quality_score := round(100 - NEW.hallucination_risk_score, 2);
  END IF;
  RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.sync_human_support_queue_from_conversation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_human boolean; v_reentered boolean; v_excluded boolean;
begin
  v_excluded := coalesce(new.metadata_source->>'source','')='widget_live_test' and coalesce((new.metadata_source->>'widget_live_test')::boolean,false)=true and coalesce((new.metadata_source->>'exclude_training')::boolean,false)=true;
  v_human := not v_excluded and new.company_id is not null and (new.assigned_agent_id is not null or new.status in ('pending','transferred','unresolved','human_needed','human_control'));
  v_reentered := tg_op='INSERT' or old.status is distinct from new.status or old.assigned_agent_id is distinct from new.assigned_agent_id;
  if v_human then
    insert into public.human_support_queue(conversation_id,company_id,queued_at,state,assigned_agent_id,assigned_at,closed_at,updated_at)
    values(new.id,new.company_id,now(),case when new.assigned_agent_id is null then 'waiting' else 'assigned' end,new.assigned_agent_id,case when new.assigned_agent_id is null then null else now() end,null,now())
    on conflict(conversation_id) do update set company_id=excluded.company_id,queued_at=case when public.human_support_queue.state='closed' or v_reentered then excluded.queued_at else public.human_support_queue.queued_at end,state=excluded.state,assigned_agent_id=excluded.assigned_agent_id,assigned_at=case when excluded.assigned_agent_id is null then null when public.human_support_queue.assigned_agent_id is distinct from excluded.assigned_agent_id then now() else coalesce(public.human_support_queue.assigned_at,now()) end,closed_at=null,updated_at=now();
  else
    update public.human_support_queue set state='closed',assigned_agent_id=null,closed_at=coalesce(closed_at,now()),updated_at=now() where conversation_id=new.id and state<>'closed';
  end if;
  return new;
end;$function$;
CREATE OR REPLACE FUNCTION public.agent_send_reply_tx(p_conversation_id uuid, p_agent_id uuid, p_content text, p_agent_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conv record;
  v_agent record;
  v_message_id uuid;
  v_content text;
  v_now timestamptz := now();
BEGIN
  v_content := btrim(COALESCE(p_content, ''));
  IF v_content = '' OR v_content = '__THINKING__' OR length(v_content) > 4000 THEN
    RETURN jsonb_build_object('result', 'invalid_content');
  END IF;

  SELECT id, status, assigned_agent_id, company_id
    INTO v_conv
    FROM public.conversations
   WHERE id = p_conversation_id
   FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v_conv.company_id IS NULL THEN RETURN jsonb_build_object('result', 'tenant_unresolved'); END IF;
  IF v_conv.status IN ('resolved', 'closed') THEN RETURN jsonb_build_object('result', 'resolved'); END IF;
  IF v_conv.assigned_agent_id IS NULL THEN RETURN jsonb_build_object('result', 'takeover_required'); END IF;
  IF v_conv.assigned_agent_id IS DISTINCT FROM p_agent_id THEN RETURN jsonb_build_object('result', 'owned_by_another_agent'); END IF;
  IF v_conv.status IS DISTINCT FROM 'pending' THEN RETURN jsonb_build_object('result', 'human_control_required'); END IF;

  SELECT id, status INTO v_agent FROM public.agent_profile WHERE id = p_agent_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'agent_not_found'); END IF;
  IF v_agent.status IS DISTINCT FROM 'active' THEN RETURN jsonb_build_object('result', 'agent_inactive'); END IF;

  DELETE FROM public.messages
   WHERE conversation_id = p_conversation_id
     AND content = '__THINKING__';

  INSERT INTO public.messages(
    conversation_id, role, content, content_type, status,
    sender_id, is_recalled, metadata
  ) VALUES (
    p_conversation_id, 'agent', v_content, 'text', 'delivered',
    p_agent_id, false,
    jsonb_build_object(
      'agent_id', p_agent_id,
      'agent_name', COALESCE(p_agent_name, ''),
      'control_commit', 'human'
    )
  ) RETURNING id INTO v_message_id;

  UPDATE public.conversations SET updated_at = v_now WHERE id = p_conversation_id;

  INSERT INTO public.audit_log(actor_id, actor_type, action, resource_type, resource_id, diff)
  VALUES (
    p_agent_id, 'agent', 'agent_send_reply', 'messages', v_message_id,
    jsonb_build_object(
      'conversation_id', p_conversation_id,
      'control_state', 'pending',
      'owner_agent_id', p_agent_id
    )
  );

  RETURN jsonb_build_object('result', 'success', 'message_id', v_message_id);
END;
$function$;
CREATE OR REPLACE FUNCTION public.claim_feedback_delivery_tx()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v record; v_now timestamptz := now();
BEGIN
  SELECT fr.id,fr.conversation_id,c.company_id,fr.channel,fr.rating_type
  INTO v
  FROM public.feedback_request fr
  JOIN public.conversations c ON c.id=fr.conversation_id
  WHERE fr.status='pending'
    AND COALESCE(fr.scheduled_at,fr.created_at) <= v_now
    AND (
      fr.delivery_status='pending' OR
      (fr.delivery_status='token_generated' AND fr.response_token_hash IS NULL
       AND fr.updated_at < v_now - interval '5 minutes')
    )
  ORDER BY COALESCE(fr.scheduled_at,fr.created_at),fr.created_at,fr.id
  FOR UPDATE OF fr SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN jsonb_build_object('result','none'); END IF;

  UPDATE public.feedback_request
  SET delivery_status='token_generated',delivery_error_type=NULL,updated_at=v_now
  WHERE id=v.id;

  RETURN jsonb_build_object(
    'result','claimed','feedback_request_id',v.id,'conversation_id',v.conversation_id,
    'company_id',v.company_id,'channel',v.channel,'rating_type',v.rating_type
  );
END
$function$;
CREATE OR REPLACE FUNCTION public.hf3_feedback_quality_score(p_rating_type text, p_rating integer)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE lower(coalesce(p_rating_type,''))
    WHEN 'nps' THEN CASE WHEN p_rating BETWEEN 0 AND 10 THEN p_rating * 10.0 END
    WHEN 'stars_1_5' THEN CASE WHEN p_rating BETWEEN 1 AND 5 THEN (p_rating - 1) * 25.0 END
    WHEN 'csat' THEN CASE WHEN p_rating BETWEEN 1 AND 5 THEN (p_rating - 1) * 25.0 END
    WHEN 'ces' THEN CASE WHEN p_rating BETWEEN 1 AND 7 THEN round(((p_rating - 1) * 100.0 / 6.0)::numeric, 2) END
    WHEN 'thumbs' THEN CASE WHEN p_rating = 1 THEN 100.0 WHEN p_rating = 0 THEN 0.0 END
    ELSE NULL
  END;
$function$;
CREATE OR REPLACE FUNCTION public.hf3_refresh_learning_case_legacy_tx(p_evaluation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  e record;
  f record;
  h record;
  s record;
  o record;
  l record;
  v_feedback_score numeric;
  v_negative boolean := false;
  v_handoff_class text := 'not_applicable';
  v_class_reasons text[] := ARRAY[]::text[];
  v_delta_dims jsonb := '[]'::jsonb;
  v_delta_count integer := 0;
  v_candidate boolean := false;
  v_candidate_reasons text[] := ARRAY[]::text[];
  v_ai_hash text;
  v_human_hash text;
  v_state text := 'observed';
  v_case_id uuid;
  v_outbox_id uuid;
BEGIN
  SELECT e0.*, c.intent
    INTO e
    FROM public.conversation_evaluation e0
    JOIN public.conversations c ON c.id = e0.conversation_id
   WHERE e0.id = p_evaluation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result','evaluation_not_found');
  END IF;

  SELECT fr.id, fr.rating_type, fr.rating, fr.responded_at
    INTO f
    FROM public.feedback_request fr
   WHERE fr.conversation_id = e.conversation_id
     AND fr.status = 'responded'
     AND fr.rating IS NOT NULL
   ORDER BY fr.responded_at DESC NULLS LAST, fr.created_at DESC
   LIMIT 1;

  IF FOUND THEN
    v_feedback_score := public.hf3_feedback_quality_score(f.rating_type, f.rating);
    v_negative := v_feedback_score IS NOT NULL AND v_feedback_score < 60;
  END IF;

  SELECT he.id, he.escalation_rule, he.handoff_reason, he.handoff_type, he.created_at
    INTO h
    FROM public.handoff_event he
   WHERE he.conversation_id = e.conversation_id
   ORDER BY he.created_at DESC NULLS LAST, he.id DESC
   LIMIT 1;

  IF FOUND THEN
    IF h.escalation_rule IN ('E1','E2','R1','S0') THEN
      v_handoff_class := 'unavoidable';
      v_class_reasons := array_append(v_class_reasons, lower(h.escalation_rule) || '_protected_handoff');
    ELSIF h.escalation_rule = 'R2' THEN
      IF e.has_verified_human_response AND (e.overall_score < 80 OR v_negative) THEN
        v_handoff_class := 'potentially_avoidable';
        v_class_reasons := array_append(v_class_reasons, 'r2_same_intent_unresolved');
      ELSE
        v_handoff_class := 'unknown';
        v_class_reasons := array_append(v_class_reasons, 'r2_without_sufficient_quality_delta');
      END IF;
    ELSE
      v_handoff_class := 'unknown';
      v_class_reasons := array_append(v_class_reasons, 'handoff_without_avoidable_evidence');
    END IF;
  END IF;

  SELECT coalesce(jsonb_agg(x.dimension ORDER BY x.dimension), '[]'::jsonb), count(*)
    INTO v_delta_dims, v_delta_count
    FROM (
      SELECT DISTINCT d.dimension
        FROM public.ce_discrepancy d
       WHERE d.evaluation_id = e.id
         AND d.dimension IS NOT NULL
         AND btrim(d.dimension) <> ''
    ) x;

  SELECT bs.evaluated_ai_reply, bs.verified_human_response
    INTO s
    FROM public.ce_bundle_snapshot bs
   WHERE bs.attempt_id = e.attempt_id
     AND bs.conversation_id = e.conversation_id
     AND bs.company_id = e.company_id
   LIMIT 1;

  IF FOUND THEN
    IF s.evaluated_ai_reply IS NOT NULL THEN
      v_ai_hash := encode(extensions.digest(convert_to(s.evaluated_ai_reply::text, 'UTF8'), 'sha256'), 'hex');
    END IF;
    IF s.verified_human_response IS NOT NULL THEN
      v_human_hash := encode(extensions.digest(convert_to(s.verified_human_response::text, 'UTF8'), 'sha256'), 'hex');
    END IF;
  END IF;

  v_candidate := e.has_verified_human_response AND (
    e.training_eligible
    OR v_negative
    OR v_handoff_class = 'potentially_avoidable'
    OR v_delta_count > 0
  );

  IF e.training_eligible THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'ce_training_eligible');
  END IF;
  IF v_negative THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'negative_customer_feedback');
  END IF;
  IF v_handoff_class = 'potentially_avoidable' THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'potentially_avoidable_handoff');
  END IF;
  IF v_delta_count > 0 THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'ai_human_answer_delta');
  END IF;
  IF NOT e.has_verified_human_response AND (e.training_eligible OR v_negative OR v_delta_count > 0) THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'human_correction_required_before_training');
  END IF;

  INSERT INTO public.hf3_learning_case(
    company_id, conversation_id, evaluation_id, feedback_request_id,
    source_handoff_event_id, intent_key, handoff_classification,
    classification_reason_codes, feedback_quality_score, has_negative_feedback,
    has_verified_human_response, ai_answer_sha256, human_answer_sha256,
    answer_delta_dimensions, training_candidate, candidate_reason_codes,
    learning_state, updated_at
  ) VALUES (
    e.company_id, e.conversation_id, e.id, f.id,
    h.id, nullif(lower(btrim(coalesce(e.intent,''))), ''), v_handoff_class,
    to_jsonb(v_class_reasons), v_feedback_score, v_negative,
    e.has_verified_human_response, v_ai_hash, v_human_hash,
    v_delta_dims, v_candidate, to_jsonb(v_candidate_reasons),
    CASE WHEN v_candidate THEN 'candidate' ELSE 'observed' END, now()
  )
  ON CONFLICT (evaluation_id) DO UPDATE SET
    company_id = EXCLUDED.company_id,
    conversation_id = EXCLUDED.conversation_id,
    feedback_request_id = EXCLUDED.feedback_request_id,
    source_handoff_event_id = EXCLUDED.source_handoff_event_id,
    intent_key = EXCLUDED.intent_key,
    handoff_classification = EXCLUDED.handoff_classification,
    classification_reason_codes = EXCLUDED.classification_reason_codes,
    feedback_quality_score = EXCLUDED.feedback_quality_score,
    has_negative_feedback = EXCLUDED.has_negative_feedback,
    has_verified_human_response = EXCLUDED.has_verified_human_response,
    ai_answer_sha256 = EXCLUDED.ai_answer_sha256,
    human_answer_sha256 = EXCLUDED.human_answer_sha256,
    answer_delta_dimensions = EXCLUDED.answer_delta_dimensions,
    training_candidate = EXCLUDED.training_candidate,
    candidate_reason_codes = EXCLUDED.candidate_reason_codes,
    learning_state = CASE
      WHEN public.hf3_learning_case.learning_state IN ('delivered','trained','kb_pending','kb_published','closed')
        THEN public.hf3_learning_case.learning_state
      ELSE EXCLUDED.learning_state
    END,
    updated_at = now()
  RETURNING id INTO v_case_id;

  IF v_candidate AND e.review_status = 'accepted' THEN
    INSERT INTO public.evaluation_training_outbox(
      evaluation_id, status, delivery_idempotency_key, source_app,
      source_deployment, evaluation_contract_version, company_id
    ) VALUES (
      e.id, 'pending', e.id::text, 'ai_chatbot',
      e.source_deployment, e.evaluation_contract_version, e.company_id
    )
    ON CONFLICT (evaluation_id) DO UPDATE SET
      status = 'pending',
      delivery_attempts = 0,
      last_attempt_at = NULL,
      last_error = NULL,
      delivered_at = NULL,
      company_id = EXCLUDED.company_id,
      source_deployment = EXCLUDED.source_deployment,
      evaluation_contract_version = EXCLUDED.evaluation_contract_version
    WHERE public.evaluation_training_outbox.status = 'failed'
      AND public.evaluation_training_outbox.last_error = 'hf3_not_approved_learning_candidate';
  ELSE
    UPDATE public.evaluation_training_outbox o0
       SET status = 'failed',
           last_error = 'hf3_not_approved_learning_candidate'
     WHERE o0.evaluation_id = e.id
       AND o0.status = 'pending';
  END IF;

  SELECT id, status INTO o
    FROM public.evaluation_training_outbox
   WHERE evaluation_id = e.id;
  IF FOUND THEN
    v_outbox_id := o.id;
    IF o.status = 'delivered' THEN v_state := 'delivered';
    ELSIF o.status IN ('pending','in_progress') THEN v_state := 'queued';
    ELSIF v_candidate THEN v_state := 'candidate';
    ELSE v_state := 'observed';
    END IF;
  ELSE
    v_state := CASE WHEN v_candidate THEN 'candidate' ELSE 'observed' END;
  END IF;

  SELECT local_state, improved_state, remote_sync_state INTO l
    FROM public.ce_training_link
   WHERE evaluation_id = e.id
     AND company_id = e.company_id
     AND link_kind = 'training_candidate'
   LIMIT 1;
  IF FOUND THEN
    IF l.improved_state = 'received' THEN v_state := 'trained'; END IF;
    IF l.improved_state = 'received' AND l.remote_sync_state = 'synced' THEN v_state := 'kb_pending'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.ce_kb_publish_state ps
       WHERE ps.evaluation_id = e.id
         AND ps.company_id = e.company_id
         AND ps.action = 'publish'
         AND ps.state = 'published'
         AND ps.remote_sync_state = 'synced'
    ) THEN
      v_state := 'kb_published';
    END IF;
  END IF;

  UPDATE public.hf3_learning_case
     SET training_outbox_id = v_outbox_id,
         learning_state = v_state,
         updated_at = now()
   WHERE id = v_case_id;

  RETURN jsonb_build_object(
    'result','success',
    'learning_case_id',v_case_id,
    'training_candidate',v_candidate,
    'review_status',e.review_status,
    'handoff_classification',v_handoff_class,
    'learning_state',v_state,
    'outbox_id',v_outbox_id
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.hf3_evaluation_refresh_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.hf3_refresh_learning_case_tx(NEW.id);
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.hf3_feedback_refresh_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_eval_id uuid;
BEGIN
  IF NEW.status = 'responded' AND NEW.rating IS NOT NULL THEN
    SELECT e.id INTO v_eval_id
      FROM public.conversation_evaluation e
     WHERE e.conversation_id = NEW.conversation_id
       AND e.freshness = 'current'
     ORDER BY e.created_at DESC
     LIMIT 1;
    IF v_eval_id IS NOT NULL THEN
      PERFORM public.hf3_refresh_learning_case_tx(v_eval_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.hf3_refresh_learning_case_tx(p_evaluation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result jsonb;
  e record;
  lc record;
  h record;
  o record;
  v_handoff_class text := 'not_applicable';
  v_class_reasons text[] := ARRAY[]::text[];
  v_candidate boolean := false;
  v_candidate_reasons text[] := ARRAY[]::text[];
  v_state text;
  v_outbox_id uuid;
BEGIN
  v_result := public.hf3_refresh_learning_case_legacy_tx(p_evaluation_id);
  IF coalesce(v_result->>'result','') <> 'success' THEN
    RETURN v_result;
  END IF;

  SELECT e0.id, e0.company_id, e0.review_status, e0.training_eligible,
         e0.has_verified_human_response
    INTO e
    FROM public.conversation_evaluation e0
   WHERE e0.id = p_evaluation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result','evaluation_not_found');
  END IF;

  SELECT * INTO lc
    FROM public.hf3_learning_case
   WHERE evaluation_id = p_evaluation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result','learning_case_not_found');
  END IF;

  SELECT he.id, he.escalation_rule, he.handoff_reason, he.handoff_type, he.created_at
    INTO h
    FROM public.handoff_event he
   WHERE he.conversation_id = lc.conversation_id
   ORDER BY
     CASE he.escalation_rule
       WHEN 'E2' THEN 1
       WHEN 'E1' THEN 2
       WHEN 'R1' THEN 3
       WHEN 'S0' THEN 4
       WHEN 'R2' THEN 5
       WHEN 'R3' THEN 6
       WHEN 'P2' THEN 7
       WHEN 'R4' THEN 8
       WHEN 'P1' THEN 9
       ELSE 99
     END,
     he.created_at DESC NULLS LAST,
     he.id DESC
   LIMIT 1;

  IF FOUND THEN
    IF h.escalation_rule IN ('E1','E2','R1','S0') THEN
      v_handoff_class := 'unavoidable';
      v_class_reasons := array_append(v_class_reasons, lower(h.escalation_rule) || '_protected_handoff');
    ELSIF h.escalation_rule = 'R2' THEN
      IF e.has_verified_human_response AND
         ((lc.feedback_quality_score IS NOT NULL AND lc.feedback_quality_score < 60)
           OR EXISTS (
             SELECT 1 FROM public.conversation_evaluation ce
              WHERE ce.id=p_evaluation_id AND ce.overall_score < 80
           )) THEN
        v_handoff_class := 'potentially_avoidable';
        v_class_reasons := array_append(v_class_reasons, 'r2_same_intent_unresolved');
      ELSE
        v_handoff_class := 'unknown';
        v_class_reasons := array_append(v_class_reasons, 'r2_without_sufficient_quality_delta');
      END IF;
    ELSE
      v_handoff_class := 'unknown';
      v_class_reasons := array_append(v_class_reasons, 'handoff_without_avoidable_evidence');
    END IF;
  END IF;

  v_candidate := e.has_verified_human_response AND (
    e.training_eligible
    OR lc.has_negative_feedback
    OR v_handoff_class = 'potentially_avoidable'
    OR jsonb_array_length(coalesce(lc.answer_delta_dimensions,'[]'::jsonb)) > 0
  );

  IF e.training_eligible THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'ce_training_eligible');
  END IF;
  IF lc.has_negative_feedback THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'negative_customer_feedback');
  END IF;
  IF v_handoff_class = 'potentially_avoidable' THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'potentially_avoidable_handoff');
  END IF;
  IF jsonb_array_length(coalesce(lc.answer_delta_dimensions,'[]'::jsonb)) > 0 THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'ai_human_answer_delta');
  END IF;
  IF NOT e.has_verified_human_response AND
     (e.training_eligible OR lc.has_negative_feedback OR
      jsonb_array_length(coalesce(lc.answer_delta_dimensions,'[]'::jsonb)) > 0) THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'human_correction_required_before_training');
  END IF;

  UPDATE public.hf3_learning_case
     SET source_handoff_event_id = h.id,
         handoff_classification = v_handoff_class,
         classification_reason_codes = to_jsonb(v_class_reasons),
         training_candidate = v_candidate,
         candidate_reason_codes = to_jsonb(v_candidate_reasons),
         learning_state = CASE
           WHEN learning_state IN ('delivered','trained','kb_pending','kb_published','closed') THEN learning_state
           WHEN v_candidate THEN 'candidate'
           ELSE 'observed'
         END,
         updated_at = now()
   WHERE evaluation_id = p_evaluation_id;

  IF v_candidate AND e.review_status='accepted' THEN
    INSERT INTO public.evaluation_training_outbox(
      evaluation_id,status,delivery_idempotency_key,source_app,
      source_deployment,evaluation_contract_version,company_id
    )
    SELECT ce.id,'pending',ce.id::text,'ai_chatbot',
           ce.source_deployment,ce.evaluation_contract_version,ce.company_id
      FROM public.conversation_evaluation ce
     WHERE ce.id=p_evaluation_id
    ON CONFLICT(evaluation_id) DO UPDATE SET
      status='pending', delivery_attempts=0, last_attempt_at=NULL,
      last_error=NULL, delivered_at=NULL,
      company_id=EXCLUDED.company_id,
      source_deployment=EXCLUDED.source_deployment,
      evaluation_contract_version=EXCLUDED.evaluation_contract_version
    WHERE public.evaluation_training_outbox.status='failed'
      AND public.evaluation_training_outbox.last_error='hf3_not_approved_learning_candidate';
  ELSE
    UPDATE public.evaluation_training_outbox
       SET status='failed', last_error='hf3_not_approved_learning_candidate'
     WHERE evaluation_id=p_evaluation_id AND status='pending';
  END IF;

  SELECT id,status INTO o
    FROM public.evaluation_training_outbox
   WHERE evaluation_id=p_evaluation_id;
  IF FOUND THEN
    v_outbox_id := o.id;
    v_state := CASE
      WHEN o.status='delivered' THEN 'delivered'
      WHEN o.status IN ('pending','in_progress') THEN 'queued'
      WHEN v_candidate THEN 'candidate'
      ELSE 'observed'
    END;
  ELSE
    v_state := CASE WHEN v_candidate THEN 'candidate' ELSE 'observed' END;
  END IF;

  UPDATE public.hf3_learning_case
     SET training_outbox_id=v_outbox_id,
         learning_state=CASE
           WHEN learning_state IN ('trained','kb_pending','kb_published','closed') THEN learning_state
           ELSE v_state
         END,
         updated_at=now()
   WHERE evaluation_id=p_evaluation_id;

  RETURN jsonb_build_object(
    'result','success',
    'learning_case_id',lc.id,
    'training_candidate',v_candidate,
    'review_status',e.review_status,
    'handoff_classification',v_handoff_class,
    'learning_state',(SELECT learning_state FROM public.hf3_learning_case WHERE evaluation_id=p_evaluation_id),
    'outbox_id',v_outbox_id
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public._ce_snapshot_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$ BEGIN RAISE EXCEPTION 'CE_SNAPSHOT_IMMUTABLE'; END $function$;
CREATE OR REPLACE FUNCTION public.c3_enrich_handoff_from_memory_tg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_outer jsonb;
  v_package jsonb;
  v_memory record;
  v_company_id uuid;
BEGIN
  IF NEW.handoff_type IS DISTINCT FROM 'ai_to_agent' OR NEW.ai_summary IS NULL THEN RETURN NEW; END IF;
  BEGIN v_outer := NEW.ai_summary::jsonb; EXCEPTION WHEN others THEN RETURN NEW; END;
  IF v_outer->>'schema_version' IS DISTINCT FROM 'c2-handoff-1.0.0' THEN RETURN NEW; END IF;
  v_package := v_outer->'structured_package';
  SELECT c.company_id INTO v_company_id FROM public.conversations c WHERE c.id=NEW.conversation_id;
  SELECT m.memory, m.markdown_projection, m.source_message_id, m.commerce_state_revision
    INTO v_memory FROM public.conversation_memory_state m
   WHERE m.conversation_id=NEW.conversation_id AND m.company_id=v_company_id;
  IF NOT FOUND OR v_memory.memory->>'conversation_id' IS DISTINCT FROM NEW.conversation_id::text
     OR v_memory.memory->>'company_id' IS DISTINCT FROM v_company_id::text
     OR v_memory.source_message_id IS DISTINCT FROM (v_package->>'generated_from_source_message_id')::uuid
  THEN RETURN NEW; END IF;
  IF v_package->>'commerce_state_revision' IS NOT NULL
     AND v_memory.commerce_state_revision IS DISTINCT FROM (v_package->>'commerce_state_revision')::bigint THEN RETURN NEW; END IF;
  v_package := jsonb_set(v_package,'{customer_preferences}',coalesce(v_memory.memory->'customer_preferences','[]'::jsonb),true);
  IF jsonb_array_length(coalesce(v_package->'open_questions','[]'::jsonb))=0 THEN
    v_package := jsonb_set(v_package,'{open_questions}',coalesce(v_memory.memory->'open_questions','[]'::jsonb),true);
  END IF;
  IF jsonb_array_length(coalesce(v_package->'pending_actions','[]'::jsonb))=0 THEN
    v_package := jsonb_set(v_package,'{pending_actions}',coalesce(v_memory.memory->'pending_actions','[]'::jsonb),true);
  END IF;
  v_package := jsonb_set(v_package,'{conversation_memory_lineage}',jsonb_build_object(
    'version',v_memory.memory->>'version','memory_revision',v_memory.memory->'memory_revision',
    'source_message_id',v_memory.source_message_id,'commerce_state_revision',v_memory.commerce_state_revision
  ),true);
  NEW.ai_summary := jsonb_set(v_outer,'{structured_package}',v_package,true)::text;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.ce_message_evaluation_dirty_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ DECLARE v_old_relevant boolean:=false;v_new_relevant boolean:=false;BEGIN IF TG_OP IN('UPDATE','DELETE') THEN v_old_relevant:=COALESCE(OLD.content,'') IS DISTINCT FROM '__THINKING__';END IF;IF TG_OP IN('INSERT','UPDATE') THEN v_new_relevant:=COALESCE(NEW.content,'') IS DISTINCT FROM '__THINKING__';END IF;IF TG_OP='INSERT' THEN IF v_new_relevant THEN PERFORM public.ce_mark_evaluation_dirty(NEW.conversation_id,now());END IF;RETURN NEW;END IF;IF TG_OP='DELETE' THEN IF v_old_relevant THEN PERFORM public.ce_mark_evaluation_dirty(OLD.conversation_id,now());END IF;RETURN OLD;END IF;IF (OLD.conversation_id IS DISTINCT FROM NEW.conversation_id OR OLD.content IS DISTINCT FROM NEW.content OR OLD.role IS DISTINCT FROM NEW.role OR COALESCE(OLD.is_recalled,false) IS DISTINCT FROM COALESCE(NEW.is_recalled,false) OR OLD.sender_id IS DISTINCT FROM NEW.sender_id OR OLD.sender_identity_verified_at IS DISTINCT FROM NEW.sender_identity_verified_at) THEN IF v_old_relevant THEN PERFORM public.ce_mark_evaluation_dirty(OLD.conversation_id,now());END IF;IF v_new_relevant AND (NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NOT v_old_relevant) THEN PERFORM public.ce_mark_evaluation_dirty(NEW.conversation_id,now());ELSIF v_new_relevant AND NEW.conversation_id IS NOT DISTINCT FROM OLD.conversation_id THEN IF NOT v_old_relevant THEN NULL;ELSE NULL;END IF;END IF;END IF;RETURN NEW;END;$function$;
CREATE OR REPLACE FUNCTION public.enforce_agent_sender_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ DECLARE v_resolved uuid;v_meta_id text;BEGIN IF TG_OP='INSERT' THEN IF NEW.role='agent' THEN IF NEW.sender_id IS NOT NULL THEN IF NOT EXISTS(SELECT 1 FROM public.agent_profile WHERE id=NEW.sender_id) THEN RAISE EXCEPTION 'CE_INVALID_AGENT_IDENTITY';END IF;NEW.sender_identity_verified_at:=now();NEW.sender_identity_source:='agent_send_reply_v1';ELSE v_meta_id:=NEW.metadata->>'agent_id';IF v_meta_id IS NULL THEN RAISE EXCEPTION 'CE_MISSING_AGENT_IDENTITY';END IF;BEGIN v_resolved:=v_meta_id::uuid;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CE_INVALID_AGENT_IDENTITY';END;IF NOT EXISTS(SELECT 1 FROM public.agent_profile WHERE id=v_resolved) THEN RAISE EXCEPTION 'CE_INVALID_AGENT_IDENTITY';END IF;NEW.sender_id:=v_resolved;NEW.sender_identity_verified_at:=now();NEW.sender_identity_source:='agent_send_reply_metadata_bridge_v1';END IF;IF NEW.sender_id IS NOT NULL AND (NEW.metadata->>'agent_id') IS NOT NULL THEN BEGIN IF NEW.sender_id!=(NEW.metadata->>'agent_id')::uuid THEN RAISE EXCEPTION 'CE_SENDER_METADATA_MISMATCH';END IF;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CE_INVALID_AGENT_IDENTITY';END;END IF;ELSE NEW.sender_id:=NULL;NEW.sender_identity_verified_at:=NULL;NEW.sender_identity_source:=NULL;END IF;END IF;IF TG_OP='UPDATE' THEN IF OLD.sender_id IS DISTINCT FROM NEW.sender_id THEN RAISE EXCEPTION 'CE_IMMUTABLE_SENDER';END IF;IF OLD.role IS DISTINCT FROM NEW.role THEN RAISE EXCEPTION 'CE_IMMUTABLE_ROLE';END IF;IF OLD.sender_identity_verified_at IS DISTINCT FROM NEW.sender_identity_verified_at THEN RAISE EXCEPTION 'CE_IMMUTABLE_PROVENANCE';END IF;IF OLD.sender_identity_source IS DISTINCT FROM NEW.sender_identity_source THEN RAISE EXCEPTION 'CE_IMMUTABLE_PROVENANCE';END IF;END IF;RETURN NEW;END;$function$;
CREATE OR REPLACE FUNCTION public.hf3_discrepancy_refresh_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.hf3_refresh_learning_case_tx(NEW.evaluation_id);
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.pr7_ce_guard_snapshot_lineage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ DECLARE v_company uuid;v_attempt record;BEGIN v_company:=public.pr7_ce_canonical_company(NEW.conversation_id);SELECT id,conversation_id,company_id,bundle_hash,evaluation_contract_version INTO v_attempt FROM public.conversation_evaluation_attempt WHERE id=NEW.attempt_id;IF NEW.company_id IS NULL OR NEW.company_id<>v_company OR v_attempt IS NULL OR v_attempt.conversation_id<>NEW.conversation_id OR v_attempt.company_id IS NULL OR v_attempt.company_id<>v_company OR v_attempt.bundle_hash IS DISTINCT FROM NEW.bundle_hash OR v_attempt.evaluation_contract_version IS DISTINCT FROM NEW.evaluation_contract_version THEN RAISE EXCEPTION 'CE_LINEAGE_SNAPSHOT_MISMATCH' USING ERRCODE='check_violation';END IF;RETURN NEW;END;$function$;
CREATE OR REPLACE FUNCTION public.trg_check_assignment_side()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$ BEGIN IF TG_OP='DELETE' THEN PERFORM public.check_conv_assignment_invariant(OLD.conversation_id);RETURN NULL;END IF;IF TG_OP='INSERT' THEN PERFORM public.check_conv_assignment_invariant(NEW.conversation_id);RETURN NULL;END IF;PERFORM public.check_conv_assignment_invariant(NEW.conversation_id);IF OLD.conversation_id IS DISTINCT FROM NEW.conversation_id THEN PERFORM public.check_conv_assignment_invariant(OLD.conversation_id);END IF;RETURN NULL;END;$function$;
CREATE OR REPLACE FUNCTION public.hf3_training_link_refresh_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.hf3_refresh_learning_case_tx(NEW.evaluation_id);
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.c2_populate_handoff_package_tg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conv record;
  v_latest_source record;
  v_commerce record;
  v_state jsonb := NULL;
  v_source_id uuid;
  v_goal text;
  v_authority text;
  v_reason_code text;
  v_entities jsonb := '[]'::jsonb;
  v_history jsonb := '[]'::jsonb;
  v_confirmed jsonb := '[]'::jsonb;
  v_open jsonb := '[]'::jsonb;
  v_pending jsonb := '[]'::jsonb;
  v_installation text := 'unknown';
  v_package jsonb;
  v_summary text;
BEGIN
  IF NEW.handoff_type IS DISTINCT FROM 'ai_to_agent' THEN
    RETURN NEW;
  END IF;

  SELECT id, company_id, status, assigned_agent_id
    INTO v_conv
    FROM public.conversations
   WHERE id = NEW.conversation_id
   FOR SHARE;
  IF NOT FOUND OR v_conv.company_id IS NULL THEN
    RAISE EXCEPTION 'C2_CONVERSATION_TENANT_UNRESOLVED' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, content, created_at
    INTO v_latest_source
    FROM public.messages
   WHERE conversation_id = NEW.conversation_id
     AND role = 'visitor'
     AND COALESCE(is_recalled, false) = false
     AND content <> '__THINKING__'
   ORDER BY created_at DESC, id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'C2_SOURCE_MESSAGE_MISSING' USING ERRCODE = 'P0001';
  END IF;

  v_source_id := COALESCE(NEW.source_message_id, v_latest_source.id);
  IF v_source_id IS DISTINCT FROM v_latest_source.id THEN
    RAISE EXCEPTION 'C2_STALE_SOURCE_MESSAGE' USING ERRCODE = '40001';
  END IF;
  NEW.source_message_id := v_source_id;

  SELECT revision, source_message_id, state, state_hash
    INTO v_commerce
    FROM public.conversation_commerce_state
   WHERE conversation_id = NEW.conversation_id
     AND company_id = v_conv.company_id
   FOR SHARE;
  IF FOUND THEN v_state := v_commerce.state; END IF;

  v_goal := left(COALESCE(
    NULLIF(btrim(v_state->>'current_intent'), ''),
    NULLIF(btrim(v_state->>'current_topic'), ''),
    NULLIF(btrim(v_latest_source.content), ''),
    'unknown'
  ), 1000);
  v_authority := COALESCE(NULLIF(NEW.escalation_rule, ''), NULLIF(NEW.branch_tag, ''), 'existing_escalation_authority');
  v_reason_code := CASE upper(v_authority)
    WHEN 'R1' THEN 'explicit_customer_request'
    WHEN 'E1' THEN 'professional_or_safety_confirmation'
    WHEN 'E2' THEN 'professional_or_safety_confirmation'
    WHEN 'S0' THEN 'operational_follow_up'
    WHEN 'R2' THEN 'unresolved_authority_or_repeated_failure'
    WHEN 'R4' THEN 'policy_exception'
    WHEN 'P2' THEN 'policy_exception'
    ELSE 'existing_escalation_authority'
  END;

  IF v_state IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'entity_id', left(COALESCE(e->>'entity_id',''), 200),
        'category', left(COALESCE(e->>'category',''), 120),
        'brand', NULLIF(left(COALESCE(e->>'brand',''), 120), ''),
        'model', NULLIF(left(COALESCE(e->>'model',''), 120), ''),
        'quantity', COALESCE((e->>'quantity')::numeric, 0),
        'status', e->>'status',
        'current_quote', (
          SELECT jsonb_build_object(
            'amount', (q->>'amount')::numeric,
            'currency', left(COALESCE(q->>'currency',''), 20),
            'status', q->>'validity_status'
          )
          FROM jsonb_array_elements(COALESCE(v_state->'quotes','[]'::jsonb)) q
          WHERE q->>'entity_id' = e->>'entity_id'
            AND q->>'quote_type' = 'current_verified'
            AND q->>'validity_status' = 'current'
          LIMIT 1
        ),
        'pending_issues', '[]'::jsonb
      )
      ORDER BY e->>'entity_id'
    ), '[]'::jsonb)
    INTO v_entities
    FROM jsonb_array_elements(COALESCE(v_state->'entities','[]'::jsonb)) e
    WHERE e->>'status' NOT IN ('cancelled','deferred');

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'key', 'quote:' || left(COALESCE(q->>'quote_id','unknown'),120),
      'value', left(COALESCE(q->>'currency',''),20) || ' ' || left(COALESCE(q->>'amount',''),50),
      'state', q->>'validity_status'
    )), '[]'::jsonb)
    INTO v_history
    FROM jsonb_array_elements(COALESCE(v_state->'quotes','[]'::jsonb)) q
    WHERE COALESCE(q->>'quote_type','') LIKE '%historical%'
       OR q->>'validity_status' IN ('historical','expired','superseded','invalid');

    v_open := COALESCE(v_state->'unresolved_items','[]'::jsonb);
    v_pending := v_open || COALESCE(v_state->'installation'->'pending_checks','[]'::jsonb);
    IF NULLIF(btrim(v_state->'conversion'->>'next_best_action'),'') IS NOT NULL THEN
      v_pending := v_pending || jsonb_build_array(left(v_state->'conversion'->>'next_best_action',500));
    END IF;

    IF v_state->'conversion'->>'order_status' = 'confirmed' THEN
      v_confirmed := v_confirmed || jsonb_build_array(jsonb_build_object('key','order','value','confirmed','source','canonical_commerce_state'));
    END IF;
    IF v_state->'conversion'->>'payment_status' = 'paid' THEN
      v_confirmed := v_confirmed || jsonb_build_array(jsonb_build_object('key','payment','value','paid','source','canonical_commerce_state'));
    END IF;
    IF COALESCE((v_state->'delivery'->>'confirmed')::boolean, false) THEN
      v_confirmed := v_confirmed || jsonb_build_array(jsonb_build_object('key','delivery','value','confirmed','source','canonical_commerce_state'));
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_state->'installation'->'items','[]'::jsonb)) i
      WHERE i->>'status' = 'pending'
    ) THEN v_installation := 'pending';
    ELSIF jsonb_array_length(COALESCE(v_state->'installation'->'items','[]'::jsonb)) > 0 THEN
      v_installation := 'confirmed';
    END IF;
  END IF;

  v_package := jsonb_build_object(
    'schema_version', 'c2-handoff-1.0.0',
    'conversation_id', NEW.conversation_id,
    'company_id', v_conv.company_id,
    'handoff_reason', left(COALESCE(NEW.handoff_reason,'Existing handoff authority'),500),
    'handoff_reason_code', v_reason_code,
    'handoff_authority', v_authority,
    'current_customer_goal', v_goal,
    'active_entities', v_entities,
    'latest_corrections', COALESCE(v_state->'latest_corrections','[]'::jsonb),
    'confirmed_facts', v_confirmed,
    'historical_or_superseded_facts', v_history,
    'transaction_state', jsonb_build_object(
      'quotation', COALESCE(v_state->'conversion'->>'quotation_status','unknown'),
      'order', COALESCE(v_state->'conversion'->>'order_status','unknown'),
      'payment', COALESCE(v_state->'conversion'->>'payment_status','unknown'),
      'delivery', CASE WHEN v_state IS NULL THEN 'unknown'
        WHEN COALESCE((v_state->'delivery'->>'confirmed')::boolean,false) THEN 'confirmed'
        ELSE 'not_confirmed' END,
      'installation', v_installation
    ),
    'open_questions', v_open,
    'pending_actions', v_pending,
    'customer_preferences', '[]'::jsonb,
    'current_authoritative_kb_facts', '[]'::jsonb,
    'citations', '[]'::jsonb,
    'safety_or_professional_requirements',
      CASE WHEN upper(v_authority) IN ('E1','E2')
        THEN jsonb_build_array(left(COALESCE(NEW.handoff_reason,'Human confirmation required'),500))
        ELSE '[]'::jsonb END,
    'recommended_next_human_action', COALESCE(
      NULLIF(left(v_state->'conversion'->>'next_best_action',500),''),
      CASE WHEN jsonb_array_length(v_pending)>0
        THEN 'Confirm: ' || left(v_pending->>0,450)
        ELSE 'Review the current request and confirm the next authorized action.' END
    ),
    'generated_from_source_message_id', v_source_id,
    'commerce_state_revision', CASE WHEN v_state IS NULL THEN NULL ELSE v_commerce.revision END,
    'generated_at', now()
  );

  v_summary := concat_ws(E'\n',
    '### Customer Goal', v_goal, '',
    '### Current State',
    '- Active entities: ' || jsonb_array_length(v_entities),
    '- Order: ' || COALESCE(v_state->'conversion'->>'order_status','unknown'),
    '- Payment: ' || COALESCE(v_state->'conversion'->>'payment_status','unknown'),
    '- Delivery: ' || CASE WHEN v_state IS NULL THEN 'unknown'
      WHEN COALESCE((v_state->'delivery'->>'confirmed')::boolean,false) THEN 'confirmed' ELSE 'not_confirmed' END,
    '- Installation: ' || v_installation, '',
    '### Latest Correction',
    CASE WHEN jsonb_array_length(COALESCE(v_state->'latest_corrections','[]'::jsonb))>0
      THEN '- ' || left(COALESCE(v_state->'latest_corrections'->>-1,''),800) ELSE '- —' END, '',
    '### Pending',
    CASE WHEN jsonb_array_length(v_pending)>0 THEN '- ' || left(v_pending->>0,800) ELSE '- —' END, '',
    '### Handoff Reason', left(COALESCE(NEW.handoff_reason,'Existing handoff authority'),500), '',
    '### Recommended Next Action', v_package->>'recommended_next_human_action'
  );

  NEW.ai_summary := jsonb_build_object(
    'schema_version','c2-handoff-1.0.0',
    'structured_package',v_package,
    'summary_markdown',v_summary
  )::text;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.ce_realtime_assistant_message_trigger_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.role='assistant' and coalesce(new.is_recalled,false)=false and coalesce(new.content,'')<>'__THINKING__' then
    perform public.ce_dispatch_realtime_evaluation_v1(new.conversation_id);
  end if;
  return new;
end;
$function$;
CREATE OR REPLACE FUNCTION public.ce_verified_correction_priority_trigger_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ DECLARE v_verified boolean;v_became_verified boolean;BEGIN v_verified:=lower(COALESCE(NEW.role,'')) IN('agent','human','human_agent','supervisor') AND NEW.sender_id IS NOT NULL AND NEW.sender_identity_verified_at IS NOT NULL AND NOT COALESCE(NEW.is_recalled,false) AND COALESCE(NEW.content,'') IS DISTINCT FROM '__THINKING__';v_became_verified:=TG_OP='INSERT' OR OLD.sender_identity_verified_at IS DISTINCT FROM NEW.sender_identity_verified_at OR OLD.sender_id IS DISTINCT FROM NEW.sender_id OR OLD.content IS DISTINCT FROM NEW.content OR COALESCE(OLD.is_recalled,false) IS DISTINCT FROM COALESCE(NEW.is_recalled,false);IF v_verified AND v_became_verified THEN IF EXISTS(SELECT 1 FROM public.ce_evaluation_state s WHERE s.conversation_id=NEW.conversation_id AND s.state='up_to_date') THEN PERFORM public.ce_mark_evaluation_dirty(NEW.conversation_id,now());END IF;PERFORM public.ce_enqueue_current_snapshot_v1(NEW.conversation_id,'verified_correction',now());END IF;RETURN NEW;END;$function$;
CREATE OR REPLACE FUNCTION public.hf3_handoff_refresh_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_eval_id uuid;
BEGIN
  SELECT e.id INTO v_eval_id
    FROM public.conversation_evaluation e
   WHERE e.conversation_id = NEW.conversation_id
     AND e.freshness = 'current'
   ORDER BY e.created_at DESC
   LIMIT 1;
  IF v_eval_id IS NOT NULL THEN
    PERFORM public.hf3_refresh_learning_case_tx(v_eval_id);
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.ce_company_elevated(p_company_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ SELECT p_company_id IS NOT NULL AND (public.has_company_role(p_company_id, auth.uid(), 'admin') OR public.has_company_role(p_company_id, auth.uid(), 'supervisor')); $function$;
CREATE OR REPLACE FUNCTION public.ce_company_read(p_company_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ SELECT p_company_id IS NOT NULL AND public.is_company_member(p_company_id, auth.uid()) AND (public.has_company_role(p_company_id, auth.uid(), 'admin') OR public.has_company_role(p_company_id, auth.uid(), 'supervisor') OR public.has_company_role(p_company_id, auth.uid(), 'qa')); $function$;
CREATE OR REPLACE FUNCTION public.ce_dispatch_realtime_evaluation_v1(p_conversation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_enqueue jsonb;
  v_job_id uuid;
  v_cfg public.ce_automation_runtime;
  v_token text;
  v_request_id bigint;
begin
  v_enqueue := public.ce_enqueue_current_snapshot_v1(p_conversation_id,'ce_dwell',now());
  if coalesce(v_enqueue->>'result','') not in ('queued','already_queued') then
    return v_enqueue;
  end if;
  v_job_id := nullif(v_enqueue->>'job_id','')::uuid;
  if v_job_id is null then return jsonb_build_object('result','job_id_missing'); end if;
  select * into v_cfg from public.ce_automation_runtime where singleton=true;
  if nullif(trim(coalesce(v_cfg.worker_url,'')),'') is null or v_cfg.worker_secret_id is null then
    return jsonb_build_object('result','worker_not_configured','job_id',v_job_id);
  end if;
  select ds.decrypted_secret into v_token from vault.decrypted_secrets ds where ds.id=v_cfg.worker_secret_id;
  if nullif(coalesce(v_token,''),'') is null then return jsonb_build_object('result','worker_token_missing','job_id',v_job_id); end if;
  select net.http_post(
    url:=v_cfg.worker_url,
    headers:=jsonb_build_object('Content-Type','application/json','X-CE-Worker-Token',v_token),
    body:=jsonb_build_object('source','realtime','job_id',v_job_id),
    timeout_milliseconds:=5000
  ) into v_request_id;
  return jsonb_build_object('result','dispatched','job_id',v_job_id,'request_id',v_request_id);
end;
$function$;
CREATE OR REPLACE FUNCTION public.has_company_role(p_company_id uuid, p_user_id uuid, p_role app_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (
    (session_user = 'postgres' and auth.uid() is null and auth.role() is null)
    or auth.role() = 'service_role'
    or p_user_id = auth.uid()
  ) and exists (
    select 1
    from public.company_membership cm
    where cm.company_id = p_company_id
      and cm.user_id = p_user_id
      and cm.role = p_role
      and cm.is_active
  );
$function$;
CREATE OR REPLACE FUNCTION public.is_company_member(p_company_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (
    (session_user = 'postgres' and auth.uid() is null and auth.role() is null)
    or auth.role() = 'service_role'
    or p_user_id = auth.uid()
  ) and exists (
    select 1
    from public.company_membership cm
    where cm.company_id = p_company_id
      and cm.user_id = p_user_id
      and cm.is_active
  );
$function$;
REVOKE ALL ON FUNCTION public.ce_trigger_snapshot_hash_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_trigger_snapshot_hash_v1(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_trigger_snapshot_hash_v1(uuid) TO "service_role";
REVOKE ALL ON FUNCTION public.ce_current_evaluation_fingerprint() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_current_evaluation_fingerprint() TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_current_evaluation_fingerprint() TO "service_role";
REVOKE ALL ON FUNCTION public.ce_runtime_conversation_company(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_runtime_conversation_company(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_runtime_conversation_company(uuid) TO "service_role";
REVOKE ALL ON FUNCTION public.check_conv_assignment_invariant(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.check_conv_assignment_invariant(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_conv_assignment_invariant(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.check_conv_assignment_invariant(uuid) TO "anon";
GRANT EXECUTE ON FUNCTION public.check_conv_assignment_invariant(uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.check_conv_assignment_invariant(uuid) TO "service_role";
REVOKE ALL ON FUNCTION public.trg_check_conversation_side() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.trg_check_conversation_side() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.trg_check_conversation_side() TO "postgres";
GRANT EXECUTE ON FUNCTION public.trg_check_conversation_side() TO "anon";
GRANT EXECUTE ON FUNCTION public.trg_check_conversation_side() TO "authenticated";
GRANT EXECUTE ON FUNCTION public.trg_check_conversation_side() TO "service_role";
REVOKE ALL ON FUNCTION public._ce_enforce_conversation_company() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public._ce_enforce_conversation_company() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public._ce_enforce_conversation_company() TO "postgres";
GRANT EXECUTE ON FUNCTION public._ce_enforce_conversation_company() TO "anon";
GRANT EXECUTE ON FUNCTION public._ce_enforce_conversation_company() TO "authenticated";
GRANT EXECUTE ON FUNCTION public._ce_enforce_conversation_company() TO "service_role";
REVOKE ALL ON FUNCTION public.pr7_ce_canonical_company(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pr7_ce_canonical_company(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.pr7_ce_canonical_company(uuid) TO "service_role";
REVOKE ALL ON FUNCTION public.ce_conversation_evaluable_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_conversation_evaluable_v1(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_conversation_evaluable_v1(uuid) TO "service_role";
REVOKE ALL ON FUNCTION public.ce_copy_evaluation_fingerprint_v1() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_copy_evaluation_fingerprint_v1() TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_copy_evaluation_fingerprint_v1() TO "service_role";
REVOKE ALL ON FUNCTION public.pr7_ce_guard_evaluation_lineage() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pr7_ce_guard_evaluation_lineage() TO "postgres";
GRANT EXECUTE ON FUNCTION public.pr7_ce_guard_evaluation_lineage() TO "service_role";
REVOKE ALL ON FUNCTION public.pr7_ce_guard_outbox_lineage() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pr7_ce_guard_outbox_lineage() TO "postgres";
GRANT EXECUTE ON FUNCTION public.pr7_ce_guard_outbox_lineage() TO "service_role";
REVOKE ALL ON FUNCTION public.ce_mark_evaluation_dirty(uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_mark_evaluation_dirty(uuid,timestamp with time zone) TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_mark_evaluation_dirty(uuid,timestamp with time zone) TO "service_role";
REVOKE ALL ON FUNCTION public.ce_enqueue_evaluation_v1(uuid,text,text,bigint,text,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_enqueue_evaluation_v1(uuid,text,text,bigint,text,timestamp with time zone) TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_enqueue_evaluation_v1(uuid,text,text,bigint,text,timestamp with time zone) TO "service_role";
REVOKE ALL ON FUNCTION public.ce_enqueue_current_snapshot_v1(uuid,text,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_enqueue_current_snapshot_v1(uuid,text,timestamp with time zone) TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_enqueue_current_snapshot_v1(uuid,text,timestamp with time zone) TO "service_role";
REVOKE ALL ON FUNCTION public.ce_resolved_priority_trigger_v1() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_resolved_priority_trigger_v1() TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_resolved_priority_trigger_v1() TO "service_role";
REVOKE ALL ON FUNCTION public.pr6_enqueue_canonical_evaluation() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pr6_enqueue_canonical_evaluation() TO "postgres";
GRANT EXECUTE ON FUNCTION public.pr6_enqueue_canonical_evaluation() TO "service_role";
REVOKE ALL ON FUNCTION public.task22_fill_hallucination_quality_v1() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.task22_fill_hallucination_quality_v1() TO "postgres";
GRANT EXECUTE ON FUNCTION public.task22_fill_hallucination_quality_v1() TO "service_role";
REVOKE ALL ON FUNCTION public.sync_human_support_queue_from_conversation() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.sync_human_support_queue_from_conversation() TO "postgres";
GRANT EXECUTE ON FUNCTION public.sync_human_support_queue_from_conversation() TO "service_role";
REVOKE ALL ON FUNCTION public.agent_send_reply_tx(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_send_reply_tx(uuid,uuid,text,text) TO "postgres";
GRANT EXECUTE ON FUNCTION public.agent_send_reply_tx(uuid,uuid,text,text) TO "service_role";
REVOKE ALL ON FUNCTION public.claim_feedback_delivery_tx() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_feedback_delivery_tx() TO "postgres";
GRANT EXECUTE ON FUNCTION public.claim_feedback_delivery_tx() TO "service_role";
REVOKE ALL ON FUNCTION public.hf3_feedback_quality_score(text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hf3_feedback_quality_score(text,integer) TO "postgres";
GRANT EXECUTE ON FUNCTION public.hf3_feedback_quality_score(text,integer) TO "service_role";
REVOKE ALL ON FUNCTION public.hf3_refresh_learning_case_legacy_tx(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hf3_refresh_learning_case_legacy_tx(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.hf3_refresh_learning_case_legacy_tx(uuid) TO "service_role";
REVOKE ALL ON FUNCTION public.hf3_evaluation_refresh_trigger() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hf3_evaluation_refresh_trigger() TO "postgres";
GRANT EXECUTE ON FUNCTION public.hf3_evaluation_refresh_trigger() TO "service_role";
REVOKE ALL ON FUNCTION public.hf3_feedback_refresh_trigger() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hf3_feedback_refresh_trigger() TO "postgres";
GRANT EXECUTE ON FUNCTION public.hf3_feedback_refresh_trigger() TO "service_role";
REVOKE ALL ON FUNCTION public.hf3_refresh_learning_case_tx(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hf3_refresh_learning_case_tx(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.hf3_refresh_learning_case_tx(uuid) TO "service_role";
REVOKE ALL ON FUNCTION public._ce_snapshot_immutable() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public._ce_snapshot_immutable() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public._ce_snapshot_immutable() TO "postgres";
GRANT EXECUTE ON FUNCTION public._ce_snapshot_immutable() TO "anon";
GRANT EXECUTE ON FUNCTION public._ce_snapshot_immutable() TO "authenticated";
GRANT EXECUTE ON FUNCTION public._ce_snapshot_immutable() TO "service_role";
REVOKE ALL ON FUNCTION public.c3_enrich_handoff_from_memory_tg() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.c3_enrich_handoff_from_memory_tg() TO "postgres";
REVOKE ALL ON FUNCTION public.ce_message_evaluation_dirty_trigger() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_message_evaluation_dirty_trigger() TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_message_evaluation_dirty_trigger() TO "service_role";
REVOKE ALL ON FUNCTION public.enforce_agent_sender_identity() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.enforce_agent_sender_identity() TO "postgres";
GRANT EXECUTE ON FUNCTION public.enforce_agent_sender_identity() TO "service_role";
REVOKE ALL ON FUNCTION public.hf3_discrepancy_refresh_trigger() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hf3_discrepancy_refresh_trigger() TO "postgres";
GRANT EXECUTE ON FUNCTION public.hf3_discrepancy_refresh_trigger() TO "service_role";
REVOKE ALL ON FUNCTION public.pr7_ce_guard_snapshot_lineage() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pr7_ce_guard_snapshot_lineage() TO "postgres";
GRANT EXECUTE ON FUNCTION public.pr7_ce_guard_snapshot_lineage() TO "service_role";
REVOKE ALL ON FUNCTION public.trg_check_assignment_side() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.trg_check_assignment_side() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.trg_check_assignment_side() TO "postgres";
GRANT EXECUTE ON FUNCTION public.trg_check_assignment_side() TO "anon";
GRANT EXECUTE ON FUNCTION public.trg_check_assignment_side() TO "authenticated";
GRANT EXECUTE ON FUNCTION public.trg_check_assignment_side() TO "service_role";
REVOKE ALL ON FUNCTION public.hf3_training_link_refresh_trigger() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hf3_training_link_refresh_trigger() TO "postgres";
GRANT EXECUTE ON FUNCTION public.hf3_training_link_refresh_trigger() TO "service_role";
REVOKE ALL ON FUNCTION public.c2_populate_handoff_package_tg() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.c2_populate_handoff_package_tg() TO "postgres";
REVOKE ALL ON FUNCTION public.ce_realtime_assistant_message_trigger_v1() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_realtime_assistant_message_trigger_v1() TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_realtime_assistant_message_trigger_v1() TO "service_role";
REVOKE ALL ON FUNCTION public.ce_verified_correction_priority_trigger_v1() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_verified_correction_priority_trigger_v1() TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_verified_correction_priority_trigger_v1() TO "service_role";
REVOKE ALL ON FUNCTION public.hf3_handoff_refresh_trigger() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.hf3_handoff_refresh_trigger() TO "postgres";
GRANT EXECUTE ON FUNCTION public.hf3_handoff_refresh_trigger() TO "service_role";
REVOKE ALL ON FUNCTION public.ce_company_elevated(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_company_elevated(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_company_elevated(uuid) TO "service_role";
GRANT EXECUTE ON FUNCTION public.ce_company_elevated(uuid) TO "authenticated";
REVOKE ALL ON FUNCTION public.ce_company_read(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_company_read(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_company_read(uuid) TO "service_role";
GRANT EXECUTE ON FUNCTION public.ce_company_read(uuid) TO "authenticated";
REVOKE ALL ON FUNCTION public.ce_dispatch_realtime_evaluation_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ce_dispatch_realtime_evaluation_v1(uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.ce_dispatch_realtime_evaluation_v1(uuid) TO "service_role";
REVOKE ALL ON FUNCTION public.has_company_role(uuid,uuid,app_role) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.has_company_role(uuid,uuid,app_role) TO "postgres";
GRANT EXECUTE ON FUNCTION public.has_company_role(uuid,uuid,app_role) TO "service_role";
GRANT EXECUTE ON FUNCTION public.has_company_role(uuid,uuid,app_role) TO "authenticated";
REVOKE ALL ON FUNCTION public.is_company_member(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.is_company_member(uuid,uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION public.is_company_member(uuid,uuid) TO "service_role";
GRANT EXECUTE ON FUNCTION public.is_company_member(uuid,uuid) TO "authenticated";
ALTER TABLE public."agent_profile" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."agent_profile" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."agent_profile" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."agent_profile" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."agent_profile" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."agent_profile" TO "service_role";
ALTER TABLE public."audit_log" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."audit_log" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."audit_log" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."audit_log" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."audit_log" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."audit_log" TO "service_role";
CREATE TRIGGER trg_ce_snapshot_immutable BEFORE UPDATE ON public.ce_bundle_snapshot FOR EACH ROW EXECUTE FUNCTION _ce_snapshot_immutable();
CREATE TRIGGER trg_pr7_ce_snapshot_lineage BEFORE INSERT OR UPDATE ON public.ce_bundle_snapshot FOR EACH ROW EXECUTE FUNCTION pr7_ce_guard_snapshot_lineage();
ALTER TABLE public."ce_bundle_snapshot" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ce_bundle_snapshot" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_bundle_snapshot" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_bundle_snapshot" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_bundle_snapshot" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_bundle_snapshot" TO "service_role";
CREATE TRIGGER trg_hf3_discrepancy_refresh AFTER INSERT OR UPDATE OF dimension, divergence_kind, severity ON public.ce_discrepancy FOR EACH ROW EXECUTE FUNCTION hf3_discrepancy_refresh_trigger();
ALTER TABLE public."ce_discrepancy" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ce_discrepancy" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_discrepancy" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_discrepancy" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_discrepancy" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_discrepancy" TO "service_role";
ALTER TABLE public."ce_evaluation_job" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ce_evaluation_job" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_evaluation_job" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_evaluation_job" TO "service_role";
ALTER TABLE public."ce_evaluation_methodology" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ce_evaluation_methodology" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_evaluation_methodology" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_evaluation_methodology" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_evaluation_methodology" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_evaluation_methodology" TO "service_role";
ALTER TABLE public."ce_evaluation_state" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ce_evaluation_state" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_evaluation_state" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_evaluation_state" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_evaluation_state" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_evaluation_state" TO "service_role";
ALTER TABLE public."ce_kb_publish_state" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ce_kb_publish_state" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_kb_publish_state" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_kb_publish_state" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_kb_publish_state" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_kb_publish_state" TO "service_role";
ALTER TABLE public."ce_local_evaluation_attempt" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ce_local_evaluation_attempt" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_local_evaluation_attempt" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_local_evaluation_attempt" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_local_evaluation_attempt" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_local_evaluation_attempt" TO "service_role";
CREATE TRIGGER trg_hf3_training_link_refresh AFTER INSERT OR UPDATE OF improved_state, remote_sync_state ON public.ce_training_link FOR EACH ROW EXECUTE FUNCTION hf3_training_link_refresh_trigger();
ALTER TABLE public."ce_training_link" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ce_training_link" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_training_link" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_training_link" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_training_link" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."ce_training_link" TO "service_role";
ALTER TABLE public."channel_config" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."channel_config" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."channel_config" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."channel_config" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."channel_config" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."channel_config" TO "service_role";
ALTER TABLE public."company" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."company" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."company" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."company" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."company" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."company" TO "service_role";
ALTER TABLE public."company_membership" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."company_membership" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."company_membership" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."company_membership" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."company_membership" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."company_membership" TO "service_role";
CREATE CONSTRAINT TRIGGER enforce_assignment_invariant_a AFTER INSERT OR DELETE OR UPDATE ON public.conversation_assignment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_check_assignment_side();
ALTER TABLE public."conversation_assignment" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."conversation_assignment" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversation_assignment" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversation_assignment" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversation_assignment" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversation_assignment" TO "service_role";
CREATE TRIGGER trg_ce_copy_fingerprint_canonical BEFORE INSERT ON public.conversation_evaluation FOR EACH ROW EXECUTE FUNCTION ce_copy_evaluation_fingerprint_v1();
CREATE TRIGGER trg_hf3_evaluation_refresh AFTER INSERT OR UPDATE OF review_status, training_eligible ON public.conversation_evaluation FOR EACH ROW EXECUTE FUNCTION hf3_evaluation_refresh_trigger();
CREATE CONSTRAINT TRIGGER trg_pr6_enqueue_canonical_evaluation AFTER INSERT ON public.conversation_evaluation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pr6_enqueue_canonical_evaluation();
CREATE TRIGGER trg_pr7_ce_evaluation_lineage BEFORE INSERT OR UPDATE ON public.conversation_evaluation FOR EACH ROW EXECUTE FUNCTION pr7_ce_guard_evaluation_lineage();
CREATE TRIGGER trg_task22_fill_hallucination_quality BEFORE INSERT ON public.conversation_evaluation FOR EACH ROW EXECUTE FUNCTION task22_fill_hallucination_quality_v1();
ALTER TABLE public."conversation_evaluation" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."conversation_evaluation" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversation_evaluation" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversation_evaluation" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversation_evaluation" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversation_evaluation" TO "service_role";
ALTER TABLE public."conversation_evaluation_attempt" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."conversation_evaluation_attempt" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversation_evaluation_attempt" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversation_evaluation_attempt" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversation_evaluation_attempt" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversation_evaluation_attempt" TO "service_role";
CREATE CONSTRAINT TRIGGER enforce_assignment_invariant_c AFTER UPDATE ON public.conversations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_check_conversation_side();
CREATE TRIGGER trg_ce_resolved_priority AFTER UPDATE OF status, resolved_at ON public.conversations FOR EACH ROW EXECUTE FUNCTION ce_resolved_priority_trigger_v1();
CREATE TRIGGER trg_conversations_company BEFORE INSERT OR UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION _ce_enforce_conversation_company();
CREATE TRIGGER trg_sync_human_support_queue AFTER INSERT OR UPDATE OF status, assigned_agent_id, company_id ON public.conversations FOR EACH ROW EXECUTE FUNCTION sync_human_support_queue_from_conversation();
ALTER TABLE public."conversations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."conversations" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversations" TO "postgres";
GRANT SELECT,INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversations" TO "anon";
GRANT SELECT,INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversations" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."conversations" TO "service_role";
CREATE TRIGGER trg_pr7_ce_outbox_lineage BEFORE INSERT OR UPDATE ON public.evaluation_training_outbox FOR EACH ROW EXECUTE FUNCTION pr7_ce_guard_outbox_lineage();
ALTER TABLE public."evaluation_training_outbox" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."evaluation_training_outbox" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."evaluation_training_outbox" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."evaluation_training_outbox" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."evaluation_training_outbox" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."evaluation_training_outbox" TO "service_role";
CREATE TRIGGER trg_hf3_feedback_refresh AFTER INSERT OR UPDATE OF status, rating, feedback_text ON public.feedback_request FOR EACH ROW EXECUTE FUNCTION hf3_feedback_refresh_trigger();
ALTER TABLE public."feedback_request" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."feedback_request" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."feedback_request" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."feedback_request" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."feedback_request" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."feedback_request" TO "service_role";
CREATE TRIGGER c2_handoff_package_before_insert BEFORE INSERT ON public.handoff_event FOR EACH ROW EXECUTE FUNCTION c2_populate_handoff_package_tg();
CREATE TRIGGER c3_enrich_handoff_from_memory_before_insert BEFORE INSERT ON public.handoff_event FOR EACH ROW EXECUTE FUNCTION c3_enrich_handoff_from_memory_tg();
CREATE TRIGGER trg_hf3_handoff_refresh AFTER INSERT OR UPDATE OF escalation_rule, handoff_reason ON public.handoff_event FOR EACH ROW EXECUTE FUNCTION hf3_handoff_refresh_trigger();
ALTER TABLE public."handoff_event" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."handoff_event" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."handoff_event" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."handoff_event" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."handoff_event" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."handoff_event" TO "service_role";
ALTER TABLE public."hf3_learning_case" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."hf3_learning_case" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."hf3_learning_case" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."hf3_learning_case" TO "service_role";
ALTER TABLE public."human_support_queue" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."human_support_queue" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."human_support_queue" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."human_support_queue" TO "service_role";
CREATE TRIGGER trg_ce_message_evaluation_dirty AFTER INSERT OR DELETE OR UPDATE OF conversation_id, content, role, is_recalled, sender_id, sender_identity_verified_at ON public.messages FOR EACH ROW EXECUTE FUNCTION ce_message_evaluation_dirty_trigger();
CREATE TRIGGER trg_enforce_agent_sender_identity BEFORE INSERT OR UPDATE OF role, sender_id, sender_identity_verified_at, sender_identity_source ON public.messages FOR EACH ROW EXECUTE FUNCTION enforce_agent_sender_identity();
CREATE TRIGGER trg_zz_ce_realtime_assistant_dispatch AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION ce_realtime_assistant_message_trigger_v1();
CREATE TRIGGER trg_zz_ce_verified_correction_priority AFTER INSERT OR UPDATE OF content, role, is_recalled, sender_id, sender_identity_verified_at ON public.messages FOR EACH ROW EXECUTE FUNCTION ce_verified_correction_priority_trigger_v1();
ALTER TABLE public."messages" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."messages" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."messages" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."messages" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."messages" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."messages" TO "service_role";
ALTER TABLE public."user_roles" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."user_roles" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."user_roles" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."user_roles" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."user_roles" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."user_roles" TO "service_role";
ALTER TABLE public."visitor_session" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."visitor_session" FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."visitor_session" TO "postgres";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."visitor_session" TO "anon";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."visitor_session" TO "authenticated";
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public."visitor_session" TO "service_role";
REVOKE ALL ON public."widget_config" FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public."ce_automation_runtime" FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public."conversation_commerce_state" FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON public."conversation_memory_state" FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY "agent_profile_select" ON public."agent_profile" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ((company_membership target_cm
     JOIN company_membership caller_cm ON (((caller_cm.company_id = target_cm.company_id) AND (caller_cm.user_id = auth.uid()) AND (caller_cm.is_active = true))))
     JOIN company co ON (((co.id = target_cm.company_id) AND (co.is_active = true))))
  WHERE ((target_cm.user_id = agent_profile.user_id) AND (target_cm.is_active = true)))));
CREATE POLICY "agent_profile_update_self_no_role" ON public."agent_profile" FOR UPDATE TO "authenticated" USING ((user_id = auth.uid())) WITH CHECK (((user_id = auth.uid()) AND (role = ( SELECT ap.role
   FROM agent_profile ap
  WHERE (ap.id = agent_profile.id))) AND (status = ( SELECT ap.status
   FROM agent_profile ap
  WHERE (ap.id = agent_profile.id)))));
CREATE POLICY "channel_config_read" ON public."channel_config" FOR SELECT TO "authenticated" USING (((company_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (company_membership cm
     JOIN company co ON (((co.id = cm.company_id) AND (co.is_active = true))))
  WHERE ((cm.company_id = channel_config.company_id) AND (cm.user_id = auth.uid()) AND (cm.is_active = true) AND ((cm.role)::text = ANY (ARRAY['admin'::text, 'supervisor'::text])))))));
CREATE POLICY "channel_config_write_admin" ON public."channel_config" FOR ALL TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM (company_membership cm
     JOIN company co ON (((co.id = cm.company_id) AND (co.is_active = true))))
  WHERE ((cm.company_id = channel_config.company_id) AND (cm.user_id = auth.uid()) AND (cm.is_active = true) AND ((cm.role)::text = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (company_membership cm
     JOIN company co ON (((co.id = cm.company_id) AND (co.is_active = true))))
  WHERE ((cm.company_id = channel_config.company_id) AND (cm.user_id = auth.uid()) AND (cm.is_active = true) AND ((cm.role)::text = 'admin'::text)))));
CREATE POLICY "company_nw" ON public."company" FOR ALL TO "authenticated" USING (false) WITH CHECK (false);
CREATE POLICY "company_sel" ON public."company" FOR SELECT TO "authenticated" USING (is_company_member(id, auth.uid()));
CREATE POLICY "cm_nw" ON public."company_membership" FOR ALL TO "authenticated" USING (false) WITH CHECK (false);
CREATE POLICY "cm_sel" ON public."company_membership" FOR SELECT TO "authenticated" USING (((user_id = auth.uid()) OR has_company_role(company_id, auth.uid(), 'admin'::app_role)));
CREATE POLICY "ev_nd" ON public."conversation_evaluation" FOR DELETE TO "authenticated" USING (false);
CREATE POLICY "ev_ni" ON public."conversation_evaluation" FOR INSERT TO "authenticated" WITH CHECK (false);
CREATE POLICY "ev_nu" ON public."conversation_evaluation" FOR UPDATE TO "authenticated" USING (false);
CREATE POLICY "ev_sel" ON public."conversation_evaluation" FOR SELECT TO "authenticated" USING (((company_id IS NOT NULL) AND is_company_member(company_id, auth.uid()) AND (ce_company_read(company_id) OR (has_company_role(company_id, auth.uid(), 'agent'::app_role) AND (EXISTS ( SELECT 1
   FROM (conversations c
     JOIN agent_profile ap ON ((ap.id = c.assigned_agent_id)))
  WHERE ((c.id = conversation_evaluation.conversation_id) AND (ap.user_id = auth.uid()) AND (ap.status = 'active'::text))))))));
CREATE POLICY "conversations_select_staff" ON public."conversations" FOR SELECT TO "authenticated" USING (((company_id IS NOT NULL) AND is_company_member(company_id, auth.uid())));
CREATE POLICY "conversations_update_staff" ON public."conversations" FOR UPDATE TO "authenticated" USING (((company_id IS NOT NULL) AND is_company_member(company_id, auth.uid()))) WITH CHECK (((company_id IS NOT NULL) AND is_company_member(company_id, auth.uid())));
CREATE POLICY "ob_nd" ON public."evaluation_training_outbox" FOR DELETE TO "authenticated" USING (false);
CREATE POLICY "ob_ni" ON public."evaluation_training_outbox" FOR INSERT TO "authenticated" WITH CHECK (false);
CREATE POLICY "ob_nu" ON public."evaluation_training_outbox" FOR UPDATE TO "authenticated" USING (false);
CREATE POLICY "ob_sel" ON public."evaluation_training_outbox" FOR SELECT TO "authenticated" USING (ce_company_elevated(company_id));
CREATE POLICY "feedback_request_insert_agent_scoped" ON public."feedback_request" FOR INSERT TO "authenticated" WITH CHECK ((conversation_id IN ( SELECT c.id
   FROM (conversations c
     JOIN agent_profile ap ON ((c.assigned_agent_id = ap.id)))
  WHERE (ap.user_id = auth.uid()))));
CREATE POLICY "feedback_request_insert_supervisor" ON public."feedback_request" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM ((conversations c
     JOIN company_membership cm ON (((cm.company_id = c.company_id) AND (cm.user_id = auth.uid()) AND (cm.is_active = true))))
     JOIN company co ON (((co.id = cm.company_id) AND (co.is_active = true))))
  WHERE ((c.id = feedback_request.conversation_id) AND ((cm.role)::text = 'supervisor'::text)))));
CREATE POLICY "feedback_request_read_tenant" ON public."feedback_request" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM conversations c
  WHERE ((c.id = feedback_request.conversation_id) AND (c.company_id IS NOT NULL) AND is_company_member(c.company_id, auth.uid())))));
CREATE POLICY "feedback_request_write_admin" ON public."feedback_request" FOR ALL TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ((conversations c
     JOIN company_membership cm ON (((cm.company_id = c.company_id) AND (cm.user_id = auth.uid()) AND (cm.is_active = true))))
     JOIN company co ON (((co.id = cm.company_id) AND (co.is_active = true))))
  WHERE ((c.id = feedback_request.conversation_id) AND ((cm.role)::text = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ((conversations c
     JOIN company_membership cm ON (((cm.company_id = c.company_id) AND (cm.user_id = auth.uid()) AND (cm.is_active = true))))
     JOIN company co ON (((co.id = cm.company_id) AND (co.is_active = true))))
  WHERE ((c.id = feedback_request.conversation_id) AND ((cm.role)::text = 'admin'::text)))));
CREATE POLICY "visitor_session_select_staff" ON public."visitor_session" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM channel_config cc
  WHERE ((cc.id = visitor_session.channel_config_id) AND (cc.company_id IS NOT NULL) AND is_company_member(cc.company_id, auth.uid())))));
GRANT UPDATE ("priority") ON public."conversations" TO "authenticated";
GRANT UPDATE ("tags") ON public."conversations" TO "authenticated";
GRANT UPDATE ("updated_at") ON public."conversations" TO "authenticated";
GRANT UPDATE ("customer_tier") ON public."conversations" TO "authenticated";
GRANT UPDATE ("intent") ON public."conversations" TO "authenticated";
GRANT UPDATE ("language") ON public."conversations" TO "authenticated";
GRANT UPDATE ("metadata_source") ON public."conversations" TO "authenticated";
GRANT UPDATE ("metadata_updated_at") ON public."conversations" TO "authenticated";
SET check_function_bodies=true;
-- ce_automation_runtime has no rows: actual worker function returns worker_not_configured before Vault/net access; neither function is stubbed.
