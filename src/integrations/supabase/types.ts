export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      _ce_t2_rls_cleanup_prov: {
        Row: {
          applied_state_hash: string | null
          existed_before: boolean
          id: number
          object_identity: string
          object_type: string
          prior_acl: string | null
          prior_cmd: string | null
          prior_def_hash: string | null
          prior_definition: string | null
          prior_owner: string | null
          prior_permissive: boolean | null
          prior_qual: string | null
          prior_rls: boolean | null
          prior_roles: string | null
          prior_with_check: string | null
          recorded_at: string
        }
        Insert: {
          applied_state_hash?: string | null
          existed_before: boolean
          id?: number
          object_identity: string
          object_type: string
          prior_acl?: string | null
          prior_cmd?: string | null
          prior_def_hash?: string | null
          prior_definition?: string | null
          prior_owner?: string | null
          prior_permissive?: boolean | null
          prior_qual?: string | null
          prior_rls?: boolean | null
          prior_roles?: string | null
          prior_with_check?: string | null
          recorded_at?: string
        }
        Update: {
          applied_state_hash?: string | null
          existed_before?: boolean
          id?: number
          object_identity?: string
          object_type?: string
          prior_acl?: string | null
          prior_cmd?: string | null
          prior_def_hash?: string | null
          prior_definition?: string | null
          prior_owner?: string | null
          prior_permissive?: boolean | null
          prior_qual?: string | null
          prior_rls?: boolean | null
          prior_roles?: string | null
          prior_with_check?: string | null
          recorded_at?: string
        }
        Relationships: []
      }
      _ce_t2f_prov_8a3c: {
        Row: {
          created: boolean
          obj_ident: string
          obj_kind: string
          prior_acl: string[] | null
          prior_def: string | null
          prior_owner: string | null
          prior_rls: boolean | null
          prior_value: Json | null
        }
        Insert: {
          created: boolean
          obj_ident: string
          obj_kind: string
          prior_acl?: string[] | null
          prior_def?: string | null
          prior_owner?: string | null
          prior_rls?: boolean | null
          prior_value?: Json | null
        }
        Update: {
          created?: boolean
          obj_ident?: string
          obj_kind?: string
          prior_acl?: string[] | null
          prior_def?: string | null
          prior_owner?: string | null
          prior_rls?: boolean | null
          prior_value?: Json | null
        }
        Relationships: []
      }
      _ce_t2r_prov_7b2d: {
        Row: {
          created: boolean
          obj_ident: string
          obj_kind: string
          prior_acl: string[] | null
          prior_def: string | null
          prior_owner: string | null
        }
        Insert: {
          created: boolean
          obj_ident: string
          obj_kind: string
          prior_acl?: string[] | null
          prior_def?: string | null
          prior_owner?: string | null
        }
        Update: {
          created?: boolean
          obj_ident?: string
          obj_kind?: string
          prior_acl?: string[] | null
          prior_def?: string | null
          prior_owner?: string | null
        }
        Relationships: []
      }
      agent_profile: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          display_name: string
          email: string
          id: string
          role: string
          status: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          display_name: string
          email: string
          id?: string
          role?: string
          status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          display_name?: string
          email?: string
          id?: string
          role?: string
          status?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      ai_reply_draft: {
        Row: {
          confidence_score: number | null
          conversation_id: string
          created_at: string | null
          draft_content: string
          draft_status: string | null
          id: string
          message_id: string | null
          model_used: string | null
          prompt_version_id: string | null
          rag_sources: Json | null
        }
        Insert: {
          confidence_score?: number | null
          conversation_id: string
          created_at?: string | null
          draft_content: string
          draft_status?: string | null
          id?: string
          message_id?: string | null
          model_used?: string | null
          prompt_version_id?: string | null
          rag_sources?: Json | null
        }
        Update: {
          confidence_score?: number | null
          conversation_id?: string
          created_at?: string | null
          draft_content?: string
          draft_status?: string | null
          id?: string
          message_id?: string | null
          model_used?: string | null
          prompt_version_id?: string | null
          rag_sources?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_reply_draft_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_reply_draft_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: string | null
          created_at: string | null
          diff: Json | null
          id: string
          ip_address: string | null
          resource_id: string | null
          resource_type: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type?: string | null
          created_at?: string | null
          diff?: Json | null
          id?: string
          ip_address?: string | null
          resource_id?: string | null
          resource_type: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: string | null
          created_at?: string | null
          diff?: Json | null
          id?: string
          ip_address?: string | null
          resource_id?: string | null
          resource_type?: string
        }
        Relationships: []
      }
      ce_automation_runtime: {
        Row: {
          automation_started_at: string | null
          background_sweep_minutes: number
          debounce_minutes: number
          enabled: boolean
          enqueue_batch_limit: number
          global_concurrency: number
          last_background_sweep_at: string | null
          max_age_minutes: number
          per_company_concurrency: number
          singleton: boolean
          updated_at: string
          worker_secret_id: string | null
          worker_token_hash: string | null
          worker_url: string | null
        }
        Insert: {
          automation_started_at?: string | null
          background_sweep_minutes?: number
          debounce_minutes?: number
          enabled?: boolean
          enqueue_batch_limit?: number
          global_concurrency?: number
          last_background_sweep_at?: string | null
          max_age_minutes?: number
          per_company_concurrency?: number
          singleton?: boolean
          updated_at?: string
          worker_secret_id?: string | null
          worker_token_hash?: string | null
          worker_url?: string | null
        }
        Update: {
          automation_started_at?: string | null
          background_sweep_minutes?: number
          debounce_minutes?: number
          enabled?: boolean
          enqueue_batch_limit?: number
          global_concurrency?: number
          last_background_sweep_at?: string | null
          max_age_minutes?: number
          per_company_concurrency?: number
          singleton?: boolean
          updated_at?: string
          worker_secret_id?: string | null
          worker_token_hash?: string | null
          worker_url?: string | null
        }
        Relationships: []
      }
      ce_bundle_snapshot: {
        Row: {
          attempt_id: string
          bundle_hash: string
          canonical_input: string
          company_id: string
          conversation_id: string
          created_at: string
          evaluated_ai_reply: Json | null
          evaluation_contract_version: string
          grounding_evidence: Json
          grounding_manifest: Json
          id: string
          kb_snapshot_id: string
          model_version: string
          normalized_transcript: Json
          policy_snapshot_id: string
          prompt_version: string
          redaction_applied: boolean
          retention_expires_at: string
          transcript_hash: string
          truncation_manifest: Json
          verified_human_response: Json | null
        }
        Insert: {
          attempt_id: string
          bundle_hash: string
          canonical_input: string
          company_id: string
          conversation_id: string
          created_at?: string
          evaluated_ai_reply?: Json | null
          evaluation_contract_version: string
          grounding_evidence: Json
          grounding_manifest: Json
          id?: string
          kb_snapshot_id: string
          model_version: string
          normalized_transcript: Json
          policy_snapshot_id: string
          prompt_version: string
          redaction_applied?: boolean
          retention_expires_at?: string
          transcript_hash: string
          truncation_manifest: Json
          verified_human_response?: Json | null
        }
        Update: {
          attempt_id?: string
          bundle_hash?: string
          canonical_input?: string
          company_id?: string
          conversation_id?: string
          created_at?: string
          evaluated_ai_reply?: Json | null
          evaluation_contract_version?: string
          grounding_evidence?: Json
          grounding_manifest?: Json
          id?: string
          kb_snapshot_id?: string
          model_version?: string
          normalized_transcript?: Json
          policy_snapshot_id?: string
          prompt_version?: string
          redaction_applied?: boolean
          retention_expires_at?: string
          transcript_hash?: string
          truncation_manifest?: Json
          verified_human_response?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "ce_bundle_snapshot_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: true
            referencedRelation: "conversation_evaluation_attempt"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_discrepancy: {
        Row: {
          ai_claim: string
          company_id: string
          created_at: string
          dimension: string
          divergence_kind: string
          evaluation_id: string
          grounded_claim: string | null
          grounding_refs: Json
          human_claim: string | null
          id: string
          severity: string
        }
        Insert: {
          ai_claim: string
          company_id: string
          created_at?: string
          dimension: string
          divergence_kind: string
          evaluation_id: string
          grounded_claim?: string | null
          grounding_refs?: Json
          human_claim?: string | null
          id?: string
          severity: string
        }
        Update: {
          ai_claim?: string
          company_id?: string
          created_at?: string
          dimension?: string
          divergence_kind?: string
          evaluation_id?: string
          grounded_claim?: string | null
          grounding_refs?: Json
          human_claim?: string | null
          id?: string
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_discrepancy_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_conversation_status_v"
            referencedColumns: ["evaluation_id"]
          },
          {
            foreignKeyName: "ce_discrepancy_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "conversation_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_emotion_point: {
        Row: {
          company_id: string
          created_at: string
          evaluation_id: string
          id: string
          message_id: string
          occurred_at: string
          sentiment: string
          sentiment_score: number
          trigger_label: string | null
          turn_index: number
        }
        Insert: {
          company_id: string
          created_at?: string
          evaluation_id: string
          id?: string
          message_id: string
          occurred_at: string
          sentiment: string
          sentiment_score: number
          trigger_label?: string | null
          turn_index: number
        }
        Update: {
          company_id?: string
          created_at?: string
          evaluation_id?: string
          id?: string
          message_id?: string
          occurred_at?: string
          sentiment?: string
          sentiment_score?: number
          trigger_label?: string | null
          turn_index?: number
        }
        Relationships: [
          {
            foreignKeyName: "ce_emotion_point_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_conversation_status_v"
            referencedColumns: ["evaluation_id"]
          },
          {
            foreignKeyName: "ce_emotion_point_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "conversation_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_evaluation_job: {
        Row: {
          attempts: number
          available_at: string
          company_id: string | null
          conversation_id: string
          created_at: string
          error_code: string | null
          evaluation_fingerprint: string
          expected_revision: number
          finished_at: string | null
          id: string
          job_key: string
          lease_expires_at: string | null
          lease_owner: string | null
          max_attempts: number
          priority: number
          snapshot_hash: string
          source: string
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          available_at?: string
          company_id?: string | null
          conversation_id: string
          created_at?: string
          error_code?: string | null
          evaluation_fingerprint: string
          expected_revision: number
          finished_at?: string | null
          id?: string
          job_key: string
          lease_expires_at?: string | null
          lease_owner?: string | null
          max_attempts?: number
          priority: number
          snapshot_hash: string
          source: string
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          available_at?: string
          company_id?: string | null
          conversation_id?: string
          created_at?: string
          error_code?: string | null
          evaluation_fingerprint?: string
          expected_revision?: number
          finished_at?: string | null
          id?: string
          job_key?: string
          lease_expires_at?: string | null
          lease_owner?: string | null
          max_attempts?: number
          priority?: number
          snapshot_hash?: string
          source?: string
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_evaluation_job_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_evaluation_methodology: {
        Row: {
          activated_at: string | null
          created_at: string
          evaluation_contract_version: string
          evaluation_fingerprint: string
          evaluator_prompt_version: string
          evaluator_schema_hash: string
          prompt_hash: string
          scoring_config_hash: string
          status: string
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          created_at?: string
          evaluation_contract_version: string
          evaluation_fingerprint: string
          evaluator_prompt_version: string
          evaluator_schema_hash: string
          prompt_hash: string
          scoring_config_hash: string
          status: string
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          created_at?: string
          evaluation_contract_version?: string
          evaluation_fingerprint?: string
          evaluator_prompt_version?: string
          evaluator_schema_hash?: string
          prompt_hash?: string
          scoring_config_hash?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      ce_evaluation_state: {
        Row: {
          company_id: string | null
          conversation_id: string
          current_evaluation_fingerprint: string | null
          current_snapshot_hash: string | null
          dirty_since: string | null
          evaluating_started_at: string | null
          last_activity_at: string | null
          last_error_code: string | null
          last_success_at: string | null
          last_success_evaluation_id: string | null
          last_success_fingerprint: string | null
          last_success_snapshot_hash: string | null
          last_success_source: string | null
          queued_at: string | null
          revision: number
          state: string
          updated_at: string
        }
        Insert: {
          company_id?: string | null
          conversation_id: string
          current_evaluation_fingerprint?: string | null
          current_snapshot_hash?: string | null
          dirty_since?: string | null
          evaluating_started_at?: string | null
          last_activity_at?: string | null
          last_error_code?: string | null
          last_success_at?: string | null
          last_success_evaluation_id?: string | null
          last_success_fingerprint?: string | null
          last_success_snapshot_hash?: string | null
          last_success_source?: string | null
          queued_at?: string | null
          revision?: number
          state?: string
          updated_at?: string
        }
        Update: {
          company_id?: string | null
          conversation_id?: string
          current_evaluation_fingerprint?: string | null
          current_snapshot_hash?: string | null
          dirty_since?: string | null
          evaluating_started_at?: string | null
          last_activity_at?: string | null
          last_error_code?: string | null
          last_success_at?: string | null
          last_success_evaluation_id?: string | null
          last_success_fingerprint?: string | null
          last_success_snapshot_hash?: string | null
          last_success_source?: string | null
          queued_at?: string | null
          revision?: number
          state?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_evaluation_state_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: true
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_feature_flags: {
        Row: {
          enabled: boolean
          key: string
          updated_at: string
        }
        Insert: {
          enabled?: boolean
          key: string
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          key?: string
          updated_at?: string
        }
        Relationships: []
      }
      ce_kb_publish_state: {
        Row: {
          action: string
          company_id: string
          created_at: string
          evaluation_id: string
          id: string
          kb_document_ref: string
          last_error: string | null
          remote_ref: string | null
          remote_sync_state: string
          requested_by: string
          state: string
          updated_at: string
        }
        Insert: {
          action: string
          company_id: string
          created_at?: string
          evaluation_id: string
          id?: string
          kb_document_ref: string
          last_error?: string | null
          remote_ref?: string | null
          remote_sync_state?: string
          requested_by: string
          state?: string
          updated_at?: string
        }
        Update: {
          action?: string
          company_id?: string
          created_at?: string
          evaluation_id?: string
          id?: string
          kb_document_ref?: string
          last_error?: string | null
          remote_ref?: string | null
          remote_sync_state?: string
          requested_by?: string
          state?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_kb_publish_state_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_conversation_status_v"
            referencedColumns: ["evaluation_id"]
          },
          {
            foreignKeyName: "ce_kb_publish_state_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "conversation_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_legacy_qa_metric: {
        Row: {
          company_id: string | null
          context_score: number
          conversation_id: string
          empathy_score: number
          id: string
          policy_accuracy_score: number
          quality_score: number | null
          recorded_at: string
          resolution_speed_score: number
          source_payload_hash: string | null
          source_record_id: string | null
          source_system: string
          vip_awareness_score: number
        }
        Insert: {
          company_id?: string | null
          context_score: number
          conversation_id: string
          empathy_score: number
          id?: string
          policy_accuracy_score: number
          quality_score?: number | null
          recorded_at?: string
          resolution_speed_score: number
          source_payload_hash?: string | null
          source_record_id?: string | null
          source_system: string
          vip_awareness_score: number
        }
        Update: {
          company_id?: string | null
          context_score?: number
          conversation_id?: string
          empathy_score?: number
          id?: string
          policy_accuracy_score?: number
          quality_score?: number | null
          recorded_at?: string
          resolution_speed_score?: number
          source_payload_hash?: string | null
          source_record_id?: string | null
          source_system?: string
          vip_awareness_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "ce_legacy_qa_metric_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "company"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ce_legacy_qa_metric_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_local_bundle_snapshot: {
        Row: {
          attempt_id: string
          bundle_hash: string
          canonical_input: string
          company_id: string | null
          conversation_id: string
          created_at: string
          evaluated_ai_reply: Json | null
          evaluation_contract_version: string
          grounding_evidence: Json
          grounding_manifest: Json
          id: string
          kb_snapshot_id: string
          model_version: string
          normalized_transcript: Json
          policy_snapshot_id: string
          prompt_version: string
          rebound_at: string | null
          rebound_run_id: string | null
          redaction_applied: boolean
          retention_expires_at: string
          transcript_hash: string
          truncation_manifest: Json
          verified_human_response: Json | null
        }
        Insert: {
          attempt_id: string
          bundle_hash: string
          canonical_input: string
          company_id?: string | null
          conversation_id: string
          created_at?: string
          evaluated_ai_reply?: Json | null
          evaluation_contract_version: string
          grounding_evidence?: Json
          grounding_manifest?: Json
          id?: string
          kb_snapshot_id?: string
          model_version: string
          normalized_transcript: Json
          policy_snapshot_id?: string
          prompt_version: string
          rebound_at?: string | null
          rebound_run_id?: string | null
          redaction_applied?: boolean
          retention_expires_at?: string
          transcript_hash: string
          truncation_manifest: Json
          verified_human_response?: Json | null
        }
        Update: {
          attempt_id?: string
          bundle_hash?: string
          canonical_input?: string
          company_id?: string | null
          conversation_id?: string
          created_at?: string
          evaluated_ai_reply?: Json | null
          evaluation_contract_version?: string
          grounding_evidence?: Json
          grounding_manifest?: Json
          id?: string
          kb_snapshot_id?: string
          model_version?: string
          normalized_transcript?: Json
          policy_snapshot_id?: string
          prompt_version?: string
          rebound_at?: string | null
          rebound_run_id?: string | null
          redaction_applied?: boolean
          retention_expires_at?: string
          transcript_hash?: string
          truncation_manifest?: Json
          verified_human_response?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "ce_local_bundle_snapshot_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: true
            referencedRelation: "ce_local_evaluation_attempt"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ce_local_bundle_snapshot_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_local_canonical_map: {
        Row: {
          canonical_evaluation_id: string
          company_id: string
          local_evaluation_id: string
          rebind_run_id: string
          rebound_at: string
          rebound_by: string
        }
        Insert: {
          canonical_evaluation_id: string
          company_id: string
          local_evaluation_id: string
          rebind_run_id: string
          rebound_at?: string
          rebound_by: string
        }
        Update: {
          canonical_evaluation_id?: string
          company_id?: string
          local_evaluation_id?: string
          rebind_run_id?: string
          rebound_at?: string
          rebound_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_local_canonical_map_canonical_evaluation_id_fkey"
            columns: ["canonical_evaluation_id"]
            isOneToOne: true
            referencedRelation: "ce_conversation_status_v"
            referencedColumns: ["evaluation_id"]
          },
          {
            foreignKeyName: "ce_local_canonical_map_canonical_evaluation_id_fkey"
            columns: ["canonical_evaluation_id"]
            isOneToOne: true
            referencedRelation: "conversation_evaluation"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ce_local_canonical_map_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "company"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ce_local_canonical_map_local_evaluation_id_fkey"
            columns: ["local_evaluation_id"]
            isOneToOne: true
            referencedRelation: "ce_local_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_local_discrepancy: {
        Row: {
          ai_claim: string | null
          dimension: string
          divergence_kind: string | null
          evaluation_id: string
          grounded_claim: string | null
          grounding_refs: Json
          human_claim: string | null
          id: string
          severity: string
        }
        Insert: {
          ai_claim?: string | null
          dimension: string
          divergence_kind?: string | null
          evaluation_id: string
          grounded_claim?: string | null
          grounding_refs?: Json
          human_claim?: string | null
          id?: string
          severity: string
        }
        Update: {
          ai_claim?: string | null
          dimension?: string
          divergence_kind?: string | null
          evaluation_id?: string
          grounded_claim?: string | null
          grounding_refs?: Json
          human_claim?: string | null
          id?: string
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_local_discrepancy_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_local_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_local_emotion_point: {
        Row: {
          evaluation_id: string
          id: string
          message_id: string | null
          occurred_at: string | null
          sentiment: string
          sentiment_score: number
          trigger_label: string | null
          turn_index: number
        }
        Insert: {
          evaluation_id: string
          id?: string
          message_id?: string | null
          occurred_at?: string | null
          sentiment: string
          sentiment_score: number
          trigger_label?: string | null
          turn_index: number
        }
        Update: {
          evaluation_id?: string
          id?: string
          message_id?: string | null
          occurred_at?: string | null
          sentiment?: string
          sentiment_score?: number
          trigger_label?: string | null
          turn_index?: number
        }
        Relationships: [
          {
            foreignKeyName: "ce_local_emotion_point_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_local_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_local_evaluation: {
        Row: {
          accuracy_score: number
          attempt_id: string
          bundle_hash: string
          canonical_evaluation_id: string | null
          company_id: string | null
          context_score: number
          conversation_id: string
          created_at: string
          evaluation_contract_version: string
          evaluation_fingerprint: string | null
          freshness: string
          grounding_manifest: Json
          hallucination_quality_score: number
          hallucination_risk_score: number
          has_verified_human_response: boolean
          id: string
          input_snapshot_hash: string
          kb_snapshot_id: string
          model_version: string
          overall_score: number
          policy_score: number
          policy_snapshot_id: string
          prompt_version: string
          rebound_at: string | null
          rebound_run_id: string | null
          review_note: string | null
          review_status: string
          reviewed_at: string | null
          reviewed_by: string | null
          sales_score: number
          severity: string
          source_deployment: string
          tone_score: number
        }
        Insert: {
          accuracy_score: number
          attempt_id: string
          bundle_hash: string
          canonical_evaluation_id?: string | null
          company_id?: string | null
          context_score: number
          conversation_id: string
          created_at?: string
          evaluation_contract_version: string
          evaluation_fingerprint?: string | null
          freshness?: string
          grounding_manifest?: Json
          hallucination_quality_score: number
          hallucination_risk_score: number
          has_verified_human_response?: boolean
          id?: string
          input_snapshot_hash: string
          kb_snapshot_id?: string
          model_version: string
          overall_score: number
          policy_score: number
          policy_snapshot_id?: string
          prompt_version: string
          rebound_at?: string | null
          rebound_run_id?: string | null
          review_note?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sales_score: number
          severity: string
          source_deployment: string
          tone_score: number
        }
        Update: {
          accuracy_score?: number
          attempt_id?: string
          bundle_hash?: string
          canonical_evaluation_id?: string | null
          company_id?: string | null
          context_score?: number
          conversation_id?: string
          created_at?: string
          evaluation_contract_version?: string
          evaluation_fingerprint?: string | null
          freshness?: string
          grounding_manifest?: Json
          hallucination_quality_score?: number
          hallucination_risk_score?: number
          has_verified_human_response?: boolean
          id?: string
          input_snapshot_hash?: string
          kb_snapshot_id?: string
          model_version?: string
          overall_score?: number
          policy_score?: number
          policy_snapshot_id?: string
          prompt_version?: string
          rebound_at?: string | null
          rebound_run_id?: string | null
          review_note?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sales_score?: number
          severity?: string
          source_deployment?: string
          tone_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "ce_local_evaluation_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: true
            referencedRelation: "ce_local_evaluation_attempt"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ce_local_evaluation_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_local_evaluation_attempt: {
        Row: {
          bundle_hash: string
          company_id: string | null
          conversation_id: string
          created_at: string
          error_code: string | null
          evaluation_contract_version: string
          evaluation_fingerprint: string | null
          id: string
          initiated_by: string
          initiated_by_kind: string
          input_snapshot_hash: string
          model_version: string
          pipeline_run_id: string
          prompt_version: string
          rebound_at: string | null
          rebound_run_id: string | null
          source_deployment: string
          status: string
          updated_at: string
        }
        Insert: {
          bundle_hash: string
          company_id?: string | null
          conversation_id: string
          created_at?: string
          error_code?: string | null
          evaluation_contract_version: string
          evaluation_fingerprint?: string | null
          id?: string
          initiated_by: string
          initiated_by_kind?: string
          input_snapshot_hash: string
          model_version: string
          pipeline_run_id?: string
          prompt_version: string
          rebound_at?: string | null
          rebound_run_id?: string | null
          source_deployment: string
          status: string
          updated_at?: string
        }
        Update: {
          bundle_hash?: string
          company_id?: string | null
          conversation_id?: string
          created_at?: string
          error_code?: string | null
          evaluation_contract_version?: string
          evaluation_fingerprint?: string | null
          id?: string
          initiated_by?: string
          initiated_by_kind?: string
          input_snapshot_hash?: string
          model_version?: string
          pipeline_run_id?: string
          prompt_version?: string
          rebound_at?: string | null
          rebound_run_id?: string | null
          source_deployment?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_local_evaluation_attempt_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_local_evaluation_detail: {
        Row: {
          created_at: string
          evaluation_id: string
          evaluator_model_version: string | null
          evaluator_prompt_version: string | null
          evaluator_type: string
          grounding_refs: Json
          id: string
          justification: string
          raw_score: number
          recommended_correction: string | null
          weight: number
          weighted_score: number
        }
        Insert: {
          created_at?: string
          evaluation_id: string
          evaluator_model_version?: string | null
          evaluator_prompt_version?: string | null
          evaluator_type: string
          grounding_refs?: Json
          id?: string
          justification: string
          raw_score: number
          recommended_correction?: string | null
          weight: number
          weighted_score: number
        }
        Update: {
          created_at?: string
          evaluation_id?: string
          evaluator_model_version?: string | null
          evaluator_prompt_version?: string | null
          evaluator_type?: string
          grounding_refs?: Json
          id?: string
          justification?: string
          raw_score?: number
          recommended_correction?: string | null
          weight?: number
          weighted_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "ce_local_evaluation_detail_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_local_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_local_next_step: {
        Row: {
          detail: string | null
          evaluation_id: string
          id: string
          ordinal: number
          owner_role: string | null
          status: string
          title: string
        }
        Insert: {
          detail?: string | null
          evaluation_id: string
          id?: string
          ordinal: number
          owner_role?: string | null
          status?: string
          title: string
        }
        Update: {
          detail?: string | null
          evaluation_id?: string
          id?: string
          ordinal?: number
          owner_role?: string | null
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_local_next_step_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_local_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_local_qa_case: {
        Row: {
          case_number: string
          created_at: string
          created_by: string
          description: string | null
          evaluation_id: string
          id: string
          priority: string
          remote_ref: string | null
          remote_sync_state: string
          status: string
          title: string
        }
        Insert: {
          case_number: string
          created_at?: string
          created_by: string
          description?: string | null
          evaluation_id: string
          id?: string
          priority?: string
          remote_ref?: string | null
          remote_sync_state?: string
          status?: string
          title: string
        }
        Update: {
          case_number?: string
          created_at?: string
          created_by?: string
          description?: string | null
          evaluation_id?: string
          id?: string
          priority?: string
          remote_ref?: string | null
          remote_sync_state?: string
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_local_qa_case_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_local_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_local_root_cause: {
        Row: {
          category: string
          created_at: string
          evaluation_id: string
          evidence_refs: Json
          id: string
          recorded_by: string
          remote_ref: string | null
          remote_sync_state: string
          summary: string
        }
        Insert: {
          category: string
          created_at?: string
          evaluation_id: string
          evidence_refs?: Json
          id?: string
          recorded_by: string
          remote_ref?: string | null
          remote_sync_state?: string
          summary: string
        }
        Update: {
          category?: string
          created_at?: string
          evaluation_id?: string
          evidence_refs?: Json
          id?: string
          recorded_by?: string
          remote_ref?: string | null
          remote_sync_state?: string
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_local_root_cause_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_local_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_next_step: {
        Row: {
          company_id: string
          created_at: string
          detail: string | null
          evaluation_id: string
          id: string
          ordinal: number
          owner_role: Database["public"]["Enums"]["app_role"] | null
          status: string
          title: string
        }
        Insert: {
          company_id: string
          created_at?: string
          detail?: string | null
          evaluation_id: string
          id?: string
          ordinal: number
          owner_role?: Database["public"]["Enums"]["app_role"] | null
          status?: string
          title: string
        }
        Update: {
          company_id?: string
          created_at?: string
          detail?: string | null
          evaluation_id?: string
          id?: string
          ordinal?: number
          owner_role?: Database["public"]["Enums"]["app_role"] | null
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_next_step_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_conversation_status_v"
            referencedColumns: ["evaluation_id"]
          },
          {
            foreignKeyName: "ce_next_step_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "conversation_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_qa_case: {
        Row: {
          case_number: string
          company_id: string
          created_at: string
          created_by: string
          description: string | null
          evaluation_id: string
          id: string
          priority: string
          remote_ref: string | null
          remote_sync_state: string
          status: string
          title: string
        }
        Insert: {
          case_number: string
          company_id: string
          created_at?: string
          created_by: string
          description?: string | null
          evaluation_id: string
          id?: string
          priority?: string
          remote_ref?: string | null
          remote_sync_state?: string
          status?: string
          title: string
        }
        Update: {
          case_number?: string
          company_id?: string
          created_at?: string
          created_by?: string
          description?: string | null
          evaluation_id?: string
          id?: string
          priority?: string
          remote_ref?: string | null
          remote_sync_state?: string
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_qa_case_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_conversation_status_v"
            referencedColumns: ["evaluation_id"]
          },
          {
            foreignKeyName: "ce_qa_case_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "conversation_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_raw_provider_output: {
        Row: {
          company_id: string
          created_at: string
          evaluation_id: string
          evaluator_type: string
          id: string
          raw_response: Json
        }
        Insert: {
          company_id: string
          created_at?: string
          evaluation_id: string
          evaluator_type: string
          id?: string
          raw_response: Json
        }
        Update: {
          company_id?: string
          created_at?: string
          evaluation_id?: string
          evaluator_type?: string
          id?: string
          raw_response?: Json
        }
        Relationships: [
          {
            foreignKeyName: "ce_raw_provider_output_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_conversation_status_v"
            referencedColumns: ["evaluation_id"]
          },
          {
            foreignKeyName: "ce_raw_provider_output_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "conversation_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_root_cause: {
        Row: {
          category: string
          company_id: string
          created_at: string
          evaluation_id: string
          evidence_refs: Json
          id: string
          recorded_by: string
          remote_ref: string | null
          remote_sync_state: string
          summary: string
        }
        Insert: {
          category: string
          company_id: string
          created_at?: string
          evaluation_id: string
          evidence_refs?: Json
          id?: string
          recorded_by: string
          remote_ref?: string | null
          remote_sync_state?: string
          summary: string
        }
        Update: {
          category?: string
          company_id?: string
          created_at?: string
          evaluation_id?: string
          evidence_refs?: Json
          id?: string
          recorded_by?: string
          remote_ref?: string | null
          remote_sync_state?: string
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_root_cause_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_conversation_status_v"
            referencedColumns: ["evaluation_id"]
          },
          {
            foreignKeyName: "ce_root_cause_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "conversation_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      ce_training_link: {
        Row: {
          company_id: string
          created_at: string
          evaluation_id: string
          id: string
          improved_result: Json | null
          improved_state: string
          link_kind: string
          local_state: string
          payload: Json
          remote_ref: string | null
          remote_sync_state: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          evaluation_id: string
          id?: string
          improved_result?: Json | null
          improved_state?: string
          link_kind: string
          local_state?: string
          payload?: Json
          remote_ref?: string | null
          remote_sync_state?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          evaluation_id?: string
          id?: string
          improved_result?: Json | null
          improved_state?: string
          link_kind?: string
          local_state?: string
          payload?: Json
          remote_ref?: string | null
          remote_sync_state?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ce_training_link_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_conversation_status_v"
            referencedColumns: ["evaluation_id"]
          },
          {
            foreignKeyName: "ce_training_link_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "conversation_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_config: {
        Row: {
          allowed_origins: string[] | null
          channel_type: string
          company_id: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          name: string
          updated_at: string | null
          widget_config_id: string | null
        }
        Insert: {
          allowed_origins?: string[] | null
          channel_type?: string
          company_id?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          updated_at?: string | null
          widget_config_id?: string | null
        }
        Update: {
          allowed_origins?: string[] | null
          channel_type?: string
          company_id?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          updated_at?: string | null
          widget_config_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "channel_config_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "company"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_config_widget_config_id_fkey"
            columns: ["widget_config_id"]
            isOneToOne: false
            referencedRelation: "widget_config"
            referencedColumns: ["id"]
          },
        ]
      }
      company: {
        Row: {
          created_at: string
          display_name: string
          external_tenant_id: string
          external_workspace_id: string
          id: string
          is_active: boolean
          platform_company_id: number
          slug: string
        }
        Insert: {
          created_at?: string
          display_name: string
          external_tenant_id: string
          external_workspace_id: string
          id?: string
          is_active?: boolean
          platform_company_id: number
          slug: string
        }
        Update: {
          created_at?: string
          display_name?: string
          external_tenant_id?: string
          external_workspace_id?: string
          id?: string
          is_active?: boolean
          platform_company_id?: number
          slug?: string
        }
        Relationships: []
      }
      company_backfill_contract: {
        Row: {
          authority: string
          id: number
          notes: string
          state: string
          unassigned_conversations: number | null
          updated_at: string
        }
        Insert: {
          authority?: string
          id?: number
          notes?: string
          state?: string
          unassigned_conversations?: number | null
          updated_at?: string
        }
        Update: {
          authority?: string
          id?: number
          notes?: string
          state?: string
          unassigned_conversations?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      company_membership: {
        Row: {
          company_id: string
          created_at: string
          id: string
          is_active: boolean
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_membership_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "company"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_assignment: {
        Row: {
          agent_id: string
          assigned_at: string | null
          assigned_by: string | null
          conversation_id: string
          id: string
          is_active: boolean | null
          unassigned_at: string | null
        }
        Insert: {
          agent_id: string
          assigned_at?: string | null
          assigned_by?: string | null
          conversation_id: string
          id?: string
          is_active?: boolean | null
          unassigned_at?: string | null
        }
        Update: {
          agent_id?: string
          assigned_at?: string | null
          assigned_by?: string | null
          conversation_id?: string
          id?: string
          is_active?: boolean | null
          unassigned_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversation_assignment_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agent_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_assignment_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "agent_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_assignment_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_evaluation: {
        Row: {
          accuracy_score: number
          attempt_id: string
          bundle_hash: string | null
          company_id: string | null
          context_score: number
          conversation_id: string
          created_at: string
          evaluated_by: string
          evaluation_contract_version: string
          evaluation_fingerprint: string | null
          freshness: string
          grounding_manifest: Json | null
          hallucination_quality_score: number
          hallucination_risk_score: number
          has_verified_human_response: boolean
          id: string
          input_snapshot_hash: string
          kb_snapshot_id: string
          model_version: string
          overall_score: number
          policy_score: number
          policy_snapshot_id: string
          prompt_version: string
          review_note: string | null
          review_status: string
          reviewed_at: string | null
          reviewed_by: string | null
          sales_score: number
          severity: string
          source_deployment: string
          tone_score: number
          training_eligible: boolean
        }
        Insert: {
          accuracy_score: number
          attempt_id: string
          bundle_hash?: string | null
          company_id?: string | null
          context_score: number
          conversation_id: string
          created_at?: string
          evaluated_by: string
          evaluation_contract_version: string
          evaluation_fingerprint?: string | null
          freshness?: string
          grounding_manifest?: Json | null
          hallucination_quality_score?: number
          hallucination_risk_score: number
          has_verified_human_response?: boolean
          id?: string
          input_snapshot_hash: string
          kb_snapshot_id: string
          model_version: string
          overall_score: number
          policy_score: number
          policy_snapshot_id: string
          prompt_version: string
          review_note?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sales_score: number
          severity: string
          source_deployment: string
          tone_score: number
          training_eligible?: boolean
        }
        Update: {
          accuracy_score?: number
          attempt_id?: string
          bundle_hash?: string | null
          company_id?: string | null
          context_score?: number
          conversation_id?: string
          created_at?: string
          evaluated_by?: string
          evaluation_contract_version?: string
          evaluation_fingerprint?: string | null
          freshness?: string
          grounding_manifest?: Json | null
          hallucination_quality_score?: number
          hallucination_risk_score?: number
          has_verified_human_response?: boolean
          id?: string
          input_snapshot_hash?: string
          kb_snapshot_id?: string
          model_version?: string
          overall_score?: number
          policy_score?: number
          policy_snapshot_id?: string
          prompt_version?: string
          review_note?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sales_score?: number
          severity?: string
          source_deployment?: string
          tone_score?: number
          training_eligible?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "conversation_evaluation_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: true
            referencedRelation: "conversation_evaluation_attempt"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_evaluation_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "company"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_evaluation_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_evaluation_attempt: {
        Row: {
          bundle_hash: string | null
          company_id: string | null
          conversation_id: string
          created_at: string
          error_message: string | null
          evaluation_contract_version: string
          evaluation_fingerprint: string | null
          grounding_manifest: Json | null
          id: string
          initiated_by: string
          initiated_by_kind: string
          input_snapshot_hash: string
          kb_snapshot_id: string
          model_version: string
          pipeline_run_id: string
          policy_snapshot_id: string
          prompt_version: string
          source_deployment: string
          status: string
          updated_at: string
        }
        Insert: {
          bundle_hash?: string | null
          company_id?: string | null
          conversation_id: string
          created_at?: string
          error_message?: string | null
          evaluation_contract_version?: string
          evaluation_fingerprint?: string | null
          grounding_manifest?: Json | null
          id?: string
          initiated_by: string
          initiated_by_kind?: string
          input_snapshot_hash: string
          kb_snapshot_id: string
          model_version: string
          pipeline_run_id?: string
          policy_snapshot_id: string
          prompt_version: string
          source_deployment: string
          status?: string
          updated_at?: string
        }
        Update: {
          bundle_hash?: string | null
          company_id?: string | null
          conversation_id?: string
          created_at?: string
          error_message?: string | null
          evaluation_contract_version?: string
          evaluation_fingerprint?: string | null
          grounding_manifest?: Json | null
          id?: string
          initiated_by?: string
          initiated_by_kind?: string
          input_snapshot_hash?: string
          kb_snapshot_id?: string
          model_version?: string
          pipeline_run_id?: string
          policy_snapshot_id?: string
          prompt_version?: string
          source_deployment?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_evaluation_attempt_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "company"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_evaluation_attempt_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_evaluation_detail: {
        Row: {
          created_at: string
          evaluation_id: string
          evaluator_model_version: string | null
          evaluator_prompt_version: string | null
          evaluator_type: string
          grounding_refs: Json | null
          id: string
          justification: string | null
          raw_llm_response: Json | null
          raw_score: number
          recommended_correction: string | null
          weight: number
          weighted_score: number
        }
        Insert: {
          created_at?: string
          evaluation_id: string
          evaluator_model_version?: string | null
          evaluator_prompt_version?: string | null
          evaluator_type: string
          grounding_refs?: Json | null
          id?: string
          justification?: string | null
          raw_llm_response?: Json | null
          raw_score: number
          recommended_correction?: string | null
          weight: number
          weighted_score: number
        }
        Update: {
          created_at?: string
          evaluation_id?: string
          evaluator_model_version?: string | null
          evaluator_prompt_version?: string | null
          evaluator_type?: string
          grounding_refs?: Json | null
          id?: string
          justification?: string | null
          raw_llm_response?: Json | null
          raw_score?: number
          recommended_correction?: string | null
          weight?: number
          weighted_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "conversation_evaluation_detail_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_conversation_status_v"
            referencedColumns: ["evaluation_id"]
          },
          {
            foreignKeyName: "conversation_evaluation_detail_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "conversation_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_status_log: {
        Row: {
          changed_by: string | null
          changed_by_type: string | null
          conversation_id: string
          created_at: string | null
          id: string
          new_status: string
          old_status: string | null
          reason: string | null
        }
        Insert: {
          changed_by?: string | null
          changed_by_type?: string | null
          conversation_id: string
          created_at?: string | null
          id?: string
          new_status: string
          old_status?: string | null
          reason?: string | null
        }
        Update: {
          changed_by?: string | null
          changed_by_type?: string | null
          conversation_id?: string
          created_at?: string | null
          id?: string
          new_status?: string
          old_status?: string | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversation_status_log_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          assigned_agent_id: string | null
          channel_config_id: string | null
          company_id: string | null
          created_at: string | null
          customer_tier: string | null
          id: string
          intent: string | null
          language: string | null
          metadata_source: Json
          metadata_updated_at: string | null
          priority: string | null
          resolved_at: string | null
          status: string
          tags: string[] | null
          updated_at: string | null
          visitor_session_id: string | null
        }
        Insert: {
          assigned_agent_id?: string | null
          channel_config_id?: string | null
          company_id?: string | null
          created_at?: string | null
          customer_tier?: string | null
          id?: string
          intent?: string | null
          language?: string | null
          metadata_source?: Json
          metadata_updated_at?: string | null
          priority?: string | null
          resolved_at?: string | null
          status?: string
          tags?: string[] | null
          updated_at?: string | null
          visitor_session_id?: string | null
        }
        Update: {
          assigned_agent_id?: string | null
          channel_config_id?: string | null
          company_id?: string | null
          created_at?: string | null
          customer_tier?: string | null
          id?: string
          intent?: string | null
          language?: string | null
          metadata_source?: Json
          metadata_updated_at?: string | null
          priority?: string | null
          resolved_at?: string | null
          status?: string
          tags?: string[] | null
          updated_at?: string | null
          visitor_session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_channel_config_id_fkey"
            columns: ["channel_config_id"]
            isOneToOne: false
            referencedRelation: "channel_config"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "company"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_visitor_session_id_fkey"
            columns: ["visitor_session_id"]
            isOneToOne: false
            referencedRelation: "visitor_session"
            referencedColumns: ["id"]
          },
        ]
      }
      evaluation_training_outbox: {
        Row: {
          company_id: string | null
          created_at: string
          delivered_at: string | null
          delivery_attempts: number
          delivery_idempotency_key: string
          evaluation_contract_version: string
          evaluation_id: string
          id: string
          last_attempt_at: string | null
          last_error: string | null
          max_attempts: number
          source_app: string
          source_deployment: string
          status: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          delivered_at?: string | null
          delivery_attempts?: number
          delivery_idempotency_key: string
          evaluation_contract_version: string
          evaluation_id: string
          id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          max_attempts?: number
          source_app?: string
          source_deployment: string
          status?: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          delivered_at?: string | null
          delivery_attempts?: number
          delivery_idempotency_key?: string
          evaluation_contract_version?: string
          evaluation_id?: string
          id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          max_attempts?: number
          source_app?: string
          source_deployment?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "evaluation_training_outbox_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "company"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evaluation_training_outbox_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "ce_conversation_status_v"
            referencedColumns: ["evaluation_id"]
          },
          {
            foreignKeyName: "evaluation_training_outbox_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "conversation_evaluation"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback_automation_config: {
        Row: {
          config: Json | null
          created_at: string | null
          delay_minutes: number | null
          id: string
          is_active: boolean | null
          name: string
          trigger_event: string
          updated_at: string | null
        }
        Insert: {
          config?: Json | null
          created_at?: string | null
          delay_minutes?: number | null
          id?: string
          is_active?: boolean | null
          name: string
          trigger_event: string
          updated_at?: string | null
        }
        Update: {
          config?: Json | null
          created_at?: string | null
          delay_minutes?: number | null
          id?: string
          is_active?: boolean | null
          name?: string
          trigger_event?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      feedback_request: {
        Row: {
          channel: string | null
          config_version_id: string | null
          conversation_id: string
          created_at: string
          delivery_error_type: string | null
          delivery_event_received_at: string | null
          delivery_status: string | null
          email_provider: string | null
          email_provider_message_id: string | null
          feedback_text: string | null
          id: string
          rating: number | null
          rating_type: string
          recipient_email: string | null
          request_type: string | null
          responded_at: string | null
          response_token_hash: string | null
          scheduled_at: string | null
          sent_at: string | null
          status: string | null
          token_created_at: string | null
          token_expires_at: string | null
          token_used_at: string | null
          updated_at: string
          visitor_session_id: string | null
        }
        Insert: {
          channel?: string | null
          config_version_id?: string | null
          conversation_id: string
          created_at?: string
          delivery_error_type?: string | null
          delivery_event_received_at?: string | null
          delivery_status?: string | null
          email_provider?: string | null
          email_provider_message_id?: string | null
          feedback_text?: string | null
          id?: string
          rating?: number | null
          rating_type?: string
          recipient_email?: string | null
          request_type?: string | null
          responded_at?: string | null
          response_token_hash?: string | null
          scheduled_at?: string | null
          sent_at?: string | null
          status?: string | null
          token_created_at?: string | null
          token_expires_at?: string | null
          token_used_at?: string | null
          updated_at?: string
          visitor_session_id?: string | null
        }
        Update: {
          channel?: string | null
          config_version_id?: string | null
          conversation_id?: string
          created_at?: string
          delivery_error_type?: string | null
          delivery_event_received_at?: string | null
          delivery_status?: string | null
          email_provider?: string | null
          email_provider_message_id?: string | null
          feedback_text?: string | null
          id?: string
          rating?: number | null
          rating_type?: string
          recipient_email?: string | null
          request_type?: string | null
          responded_at?: string | null
          response_token_hash?: string | null
          scheduled_at?: string | null
          sent_at?: string | null
          status?: string | null
          token_created_at?: string | null
          token_expires_at?: string | null
          token_used_at?: string | null
          updated_at?: string
          visitor_session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "feedback_request_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_request_visitor_session_id_fkey"
            columns: ["visitor_session_id"]
            isOneToOne: false
            referencedRelation: "visitor_session"
            referencedColumns: ["id"]
          },
        ]
      }
      final_prompt_trace: {
        Row: {
          conversation_id: string | null
          created_at: string | null
          id: string
          latency_ms: number | null
          message_id: string | null
          model_used: string | null
          rag_context: Json | null
          system_prompt_snapshot: string | null
          token_input: number | null
          token_output: number | null
          tool_calls: Json | null
          user_message: string | null
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string | null
          id?: string
          latency_ms?: number | null
          message_id?: string | null
          model_used?: string | null
          rag_context?: Json | null
          system_prompt_snapshot?: string | null
          token_input?: number | null
          token_output?: number | null
          tool_calls?: Json | null
          user_message?: string | null
        }
        Update: {
          conversation_id?: string | null
          created_at?: string | null
          id?: string
          latency_ms?: number | null
          message_id?: string | null
          model_used?: string | null
          rag_context?: Json | null
          system_prompt_snapshot?: string | null
          token_input?: number | null
          token_output?: number | null
          tool_calls?: Json | null
          user_message?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "final_prompt_trace_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "final_prompt_trace_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_event: {
        Row: {
          ai_summary: string | null
          branch_tag: string | null
          conversation_id: string
          created_at: string | null
          escalation_rule: string | null
          from_agent_id: string | null
          handoff_reason: string
          handoff_type: string
          id: string
          safe_reply_content: string | null
          source_message_id: string | null
          to_agent_id: string | null
        }
        Insert: {
          ai_summary?: string | null
          branch_tag?: string | null
          conversation_id: string
          created_at?: string | null
          escalation_rule?: string | null
          from_agent_id?: string | null
          handoff_reason: string
          handoff_type: string
          id?: string
          safe_reply_content?: string | null
          source_message_id?: string | null
          to_agent_id?: string | null
        }
        Update: {
          ai_summary?: string | null
          branch_tag?: string | null
          conversation_id?: string
          created_at?: string | null
          escalation_rule?: string | null
          from_agent_id?: string | null
          handoff_reason?: string
          handoff_type?: string
          id?: string
          safe_reply_content?: string | null
          source_message_id?: string | null
          to_agent_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "handoff_event_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      message_attachment_private: {
        Row: {
          company_id: string
          conversation_id: string
          created_at: string
          message_id: string
          storage_bucket: string
          storage_path: string
        }
        Insert: {
          company_id: string
          conversation_id: string
          created_at?: string
          message_id: string
          storage_bucket: string
          storage_path: string
        }
        Update: {
          company_id?: string
          conversation_id?: string
          created_at?: string
          message_id?: string
          storage_bucket?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_attachment_private_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_attachment_private_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: true
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          content: string
          content_type: string | null
          conversation_id: string
          created_at: string | null
          id: string
          is_recalled: boolean | null
          metadata: Json | null
          role: string
          sender_id: string | null
          sender_identity_source: string | null
          sender_identity_verified_at: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          content: string
          content_type?: string | null
          conversation_id: string
          created_at?: string | null
          id?: string
          is_recalled?: boolean | null
          metadata?: Json | null
          role: string
          sender_id?: string | null
          sender_identity_source?: string | null
          sender_identity_verified_at?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          content?: string
          content_type?: string | null
          conversation_id?: string
          created_at?: string | null
          id?: string
          is_recalled?: boolean | null
          metadata?: Json | null
          role?: string
          sender_id?: string | null
          sender_identity_source?: string | null
          sender_identity_verified_at?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "agent_profile"
            referencedColumns: ["id"]
          },
        ]
      }
      migration_object_ledger: {
        Row: {
          disposition: string
          migration_id: string
          object_ident: string
          object_kind: string
          pre_acl: string | null
          pre_definition: string | null
          pre_owner: string | null
          pre_rls_enabled: boolean | null
          recorded_at: string
        }
        Insert: {
          disposition: string
          migration_id: string
          object_ident: string
          object_kind: string
          pre_acl?: string | null
          pre_definition?: string | null
          pre_owner?: string | null
          pre_rls_enabled?: boolean | null
          recorded_at?: string
        }
        Update: {
          disposition?: string
          migration_id?: string
          object_ident?: string
          object_kind?: string
          pre_acl?: string | null
          pre_definition?: string | null
          pre_owner?: string | null
          pre_rls_enabled?: boolean | null
          recorded_at?: string
        }
        Relationships: []
      }
      pr7_channel_ownership_row: {
        Row: {
          assigned_company_id: string
          channel_id: string
          previous_company_id: string | null
          run_id: string
        }
        Insert: {
          assigned_company_id: string
          channel_id: string
          previous_company_id?: string | null
          run_id: string
        }
        Update: {
          assigned_company_id?: string
          channel_id?: string
          previous_company_id?: string | null
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pr7_channel_ownership_row_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "pr7_channel_ownership_run"
            referencedColumns: ["run_id"]
          },
        ]
      }
      pr7_channel_ownership_run: {
        Row: {
          company_id: string
          completed_at: string | null
          rolled_back_at: string | null
          run_id: string
          started_at: string
        }
        Insert: {
          company_id: string
          completed_at?: string | null
          rolled_back_at?: string | null
          run_id: string
          started_at?: string
        }
        Update: {
          company_id?: string
          completed_at?: string | null
          rolled_back_at?: string | null
          run_id?: string
          started_at?: string
        }
        Relationships: []
      }
      pr7_company_identity_bootstrap_run: {
        Row: {
          company_uuid: string
          completed_at: string | null
          created_company: boolean
          platform_company_id: number
          rolled_back_at: string | null
          run_id: string
          started_at: string
        }
        Insert: {
          company_uuid: string
          completed_at?: string | null
          created_company: boolean
          platform_company_id: number
          rolled_back_at?: string | null
          run_id: string
          started_at?: string
        }
        Update: {
          company_uuid?: string
          completed_at?: string | null
          created_company?: boolean
          platform_company_id?: number
          rolled_back_at?: string | null
          run_id?: string
          started_at?: string
        }
        Relationships: []
      }
      pr7_conversation_lineage_row: {
        Row: {
          assigned_company_id: string
          lineage_source: string
          previous_company_id: string | null
          row_id: string
          run_id: string
          table_name: string
        }
        Insert: {
          assigned_company_id: string
          lineage_source: string
          previous_company_id?: string | null
          row_id: string
          run_id: string
          table_name: string
        }
        Update: {
          assigned_company_id?: string
          lineage_source?: string
          previous_company_id?: string | null
          row_id?: string
          run_id?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "pr7_conversation_lineage_row_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "pr7_conversation_lineage_run"
            referencedColumns: ["run_id"]
          },
        ]
      }
      pr7_conversation_lineage_run: {
        Row: {
          company_id: string
          completed_at: string | null
          rolled_back_at: string | null
          run_id: string
          started_at: string
        }
        Insert: {
          company_id: string
          completed_at?: string | null
          rolled_back_at?: string | null
          run_id: string
          started_at?: string
        }
        Update: {
          company_id?: string
          completed_at?: string | null
          rolled_back_at?: string | null
          run_id?: string
          started_at?: string
        }
        Relationships: []
      }
      pr7_membership_bootstrap_row: {
        Row: {
          company_id: string
          created_by_run: boolean
          is_active: boolean
          membership_id: string
          role: Database["public"]["Enums"]["app_role"]
          run_id: string
          user_id: string
        }
        Insert: {
          company_id: string
          created_by_run: boolean
          is_active: boolean
          membership_id: string
          role: Database["public"]["Enums"]["app_role"]
          run_id: string
          user_id: string
        }
        Update: {
          company_id?: string
          created_by_run?: boolean
          is_active?: boolean
          membership_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          run_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pr7_membership_bootstrap_row_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "pr7_membership_bootstrap_run"
            referencedColumns: ["run_id"]
          },
        ]
      }
      pr7_membership_bootstrap_run: {
        Row: {
          company_id: string
          completed_at: string | null
          rolled_back_at: string | null
          run_id: string
          started_at: string
        }
        Insert: {
          company_id: string
          completed_at?: string | null
          rolled_back_at?: string | null
          run_id: string
          started_at?: string
        }
        Update: {
          company_id?: string
          completed_at?: string | null
          rolled_back_at?: string | null
          run_id?: string
          started_at?: string
        }
        Relationships: []
      }
      rag_trace: {
        Row: {
          conversation_id: string | null
          created_at: string | null
          id: string
          kb_source: string | null
          message_id: string | null
          query_sent: string | null
          retrieved_chunks: Json | null
          top_score: number | null
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string | null
          id?: string
          kb_source?: string | null
          message_id?: string | null
          query_sent?: string | null
          retrieved_chunks?: Json | null
          top_score?: number | null
        }
        Update: {
          conversation_id?: string | null
          created_at?: string | null
          id?: string
          kb_source?: string | null
          message_id?: string | null
          query_sent?: string | null
          retrieved_chunks?: Json | null
          top_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "rag_trace_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rag_trace_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      upstream_call_log: {
        Row: {
          company_id: string | null
          conversation_id: string | null
          created_at: string | null
          error_message: string | null
          id: string
          request_payload: Json | null
          response_latency_ms: number | null
          response_status: number | null
          upstream_service: string
        }
        Insert: {
          company_id?: string | null
          conversation_id?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          request_payload?: Json | null
          response_latency_ms?: number | null
          response_status?: number | null
          upstream_service: string
        }
        Update: {
          company_id?: string | null
          conversation_id?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          request_payload?: Json | null
          response_latency_ms?: number | null
          response_status?: number | null
          upstream_service?: string
        }
        Relationships: [
          {
            foreignKeyName: "upstream_call_log_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "company"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "upstream_call_log_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      visitor_session: {
        Row: {
          channel_config_id: string | null
          created_at: string | null
          id: string
          last_seen_at: string | null
          session_token: string
          visitor_fingerprint: string | null
          visitor_metadata: Json | null
        }
        Insert: {
          channel_config_id?: string | null
          created_at?: string | null
          id?: string
          last_seen_at?: string | null
          session_token?: string
          visitor_fingerprint?: string | null
          visitor_metadata?: Json | null
        }
        Update: {
          channel_config_id?: string | null
          created_at?: string | null
          id?: string
          last_seen_at?: string | null
          session_token?: string
          visitor_fingerprint?: string | null
          visitor_metadata?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "visitor_session_channel_config_id_fkey"
            columns: ["channel_config_id"]
            isOneToOne: false
            referencedRelation: "channel_config"
            referencedColumns: ["id"]
          },
        ]
      }
      widget_config: {
        Row: {
          created_at: string | null
          header_title: string
          id: string
          is_active: boolean | null
          logo_url: string | null
          name: string
          placeholder_text: string | null
          primary_color: string | null
          updated_at: string | null
          welcome_message: string | null
        }
        Insert: {
          created_at?: string | null
          header_title?: string
          id?: string
          is_active?: boolean | null
          logo_url?: string | null
          name: string
          placeholder_text?: string | null
          primary_color?: string | null
          updated_at?: string | null
          welcome_message?: string | null
        }
        Update: {
          created_at?: string | null
          header_title?: string
          id?: string
          is_active?: boolean | null
          logo_url?: string | null
          name?: string
          placeholder_text?: string | null
          primary_color?: string | null
          updated_at?: string | null
          welcome_message?: string | null
        }
        Relationships: []
      }
      widget_session_event: {
        Row: {
          created_at: string | null
          event_data: Json | null
          event_type: string
          id: string
          page_url: string | null
          visitor_session_id: string | null
        }
        Insert: {
          created_at?: string | null
          event_data?: Json | null
          event_type: string
          id?: string
          page_url?: string | null
          visitor_session_id?: string | null
        }
        Update: {
          created_at?: string | null
          event_data?: Json | null
          event_type?: string
          id?: string
          page_url?: string | null
          visitor_session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "widget_session_event_visitor_session_id_fkey"
            columns: ["visitor_session_id"]
            isOneToOne: false
            referencedRelation: "visitor_session"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      ce_conversation_status_v: {
        Row: {
          company_id: string | null
          conversation_id: string | null
          delivered_at: string | null
          evaluated_at: string | null
          evaluation_id: string | null
          has_verified_human_response: boolean | null
          improved_result_received_at: string | null
          improved_result_state: string | null
          improved_result_status: string | null
          needs_review: boolean | null
          outbox_status: string | null
          overall_score: number | null
          review_status: string | null
          severity: string | null
          trained: boolean | null
          training_eligible: boolean | null
          training_ready: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "conversation_evaluation_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "company"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_evaluation_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _ce_exists: {
        Args: { p_ident: string; p_kind: string }
        Returns: boolean
      }
      _ce_facl: { Args: { p_sig: string }; Returns: string }
      _ce_ledger: {
        Args: {
          p_acl?: string
          p_def?: string
          p_disp: string
          p_ident: string
          p_kind: string
          p_owner?: string
          p_rls?: boolean
        }
        Returns: undefined
      }
      _ce_rls: { Args: { p_table: string }; Returns: boolean }
      agent_send_attachment_tx: {
        Args: {
          p_agent_id: string
          p_agent_name?: string
          p_content_type: string
          p_conversation_id: string
          p_mime_type: string
          p_original_name: string
          p_size_bytes: number
          p_storage_path: string
        }
        Returns: Json
      }
      assign_conversation_tx: {
        Args: {
          p_actor_agent_id: string
          p_conversation_id: string
          p_expected_owner?: string
          p_expected_status: string
          p_target_agent_id: string
        }
        Returns: Json
      }
      ce_activate_evaluation_methodology_v1: {
        Args: {
          p_contract_version: string
          p_evaluator_schema_hash: string
          p_mark_existing_stale?: boolean
          p_prompt_hash: string
          p_prompt_version: string
          p_scoring_config_hash: string
        }
        Returns: Json
      }
      ce_activate_scheduler_v1: {
        Args: { p_worker_url: string }
        Returns: Json
      }
      ce_automation_initiate_canonical_v1: {
        Args: {
          p_bundle_hash: string
          p_contract_version: string
          p_grounding_manifest: Json
          p_input_snapshot_hash: string
          p_job_id: string
          p_kb_snapshot_id: string
          p_model_version: string
          p_policy_snapshot_id: string
          p_prompt_version: string
          p_source_deployment: string
        }
        Returns: Json
      }
      ce_automation_initiate_local_v1: {
        Args: {
          p_bundle_hash: string
          p_contract_version: string
          p_input_snapshot_hash: string
          p_job_id: string
          p_model_version: string
          p_prompt_version: string
          p_source_deployment: string
        }
        Returns: Json
      }
      ce_claim_evaluation_jobs_v1: {
        Args: { p_limit?: number; p_worker_id: string }
        Returns: {
          attempts: number
          available_at: string
          company_id: string | null
          conversation_id: string
          created_at: string
          error_code: string | null
          evaluation_fingerprint: string
          expected_revision: number
          finished_at: string | null
          id: string
          job_key: string
          lease_expires_at: string | null
          lease_owner: string | null
          max_attempts: number
          priority: number
          snapshot_hash: string
          source: string
          started_at: string | null
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "ce_evaluation_job"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      ce_claim_specific_job_v1: {
        Args: { p_job_id: string; p_worker_id: string }
        Returns: Json
      }
      ce_company_elevated: { Args: { p_company_id: string }; Returns: boolean }
      ce_company_read: { Args: { p_company_id: string }; Returns: boolean }
      ce_complete_job_v1: { Args: { p_job_id: string }; Returns: Json }
      ce_conversation_evaluable_v1: {
        Args: { p_conversation_id: string }
        Returns: boolean
      }
      ce_create_local_qa_case_v1: {
        Args: {
          p_description?: string
          p_evaluation_id: string
          p_expected_conversation_id: string
          p_priority?: string
          p_title: string
        }
        Returns: Json
      }
      ce_current_evaluation_fingerprint: { Args: never; Returns: string }
      ce_deactivate_scheduler_v1: { Args: never; Returns: Json }
      ce_enqueue_current_snapshot_v1: {
        Args: {
          p_available_at?: string
          p_conversation_id: string
          p_source: string
        }
        Returns: Json
      }
      ce_enqueue_evaluation_v1: {
        Args: {
          p_available_at?: string
          p_conversation_id: string
          p_evaluation_fingerprint: string
          p_expected_revision: number
          p_snapshot_hash: string
          p_source: string
        }
        Returns: Json
      }
      ce_fail_job_v1: {
        Args: { p_error_code: string; p_job_id: string }
        Returns: Json
      }
      ce_finalize_evaluation_freshness_v1: {
        Args: {
          p_conversation_id: string
          p_evaluation_fingerprint: string
          p_evaluation_id: string
          p_evaluation_source: string
          p_expected_revision: number
          p_snapshot_hash: string
          p_success_at?: string
        }
        Returns: Json
      }
      ce_is_flag_enabled: { Args: { p_key: string }; Returns: boolean }
      ce_local_actor_can_evaluate: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      ce_local_actor_can_review: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      ce_mark_evaluation_dirty: {
        Args: { p_activity_at?: string; p_conversation_id: string }
        Returns: undefined
      }
      ce_purge_expired_snapshots: { Args: never; Returns: Json }
      ce_reap_expired_jobs_v1: { Args: never; Returns: number }
      ce_record_local_root_cause_v1: {
        Args: {
          p_category: string
          p_evaluation_id: string
          p_evidence?: Json
          p_expected_conversation_id: string
          p_summary: string
        }
        Returns: Json
      }
      ce_runtime_conversation_company: {
        Args: { p_conversation_id: string }
        Returns: string
      }
      ce_scheduler_enqueue_due_v1: { Args: never; Returns: Json }
      ce_scheduler_http_tick_v1: { Args: never; Returns: number }
      ce_trigger_snapshot_hash_v1: {
        Args: { p_conversation_id: string }
        Returns: string
      }
      ce_verify_worker_token_v1: { Args: { p_token: string }; Returns: boolean }
      check_conv_assignment_invariant: {
        Args: { p_conv_id: string }
        Returns: undefined
      }
      claim_pr6b_kb_finalize_tx: { Args: never; Returns: Json }
      claim_pr6b_kb_sync_tx: { Args: never; Returns: Json }
      commit_ai_reply_tx: {
        Args: {
          p_content: string
          p_conversation_id: string
          p_metadata?: Json
          p_source_message_id: string
        }
        Returns: Json
      }
      complete_evaluation: {
        Args: { p_attempt_id: string; p_scores: Json }
        Returns: Json
      }
      complete_evaluation_v2: {
        Args: {
          p_attempt_id: string
          p_bundle_hash: string
          p_derived: Json
          p_details: Json
          p_scores: Json
          p_snapshot: Json
        }
        Returns: Json
      }
      complete_local_evaluation_v1: {
        Args: {
          p_attempt_id: string
          p_bundle_hash: string
          p_derived: Json
          p_details: Json
          p_scores: Json
          p_snapshot: Json
        }
        Returns: Json
      }
      create_widget_session_tx: {
        Args: {
          p_channel_id: string
          p_page_url: string
          p_session_token: string
          p_visitor_fingerprint: string
          p_visitor_metadata: Json
        }
        Returns: Json
      }
      explicit_handoff_tx: {
        Args: {
          p_conversation_id: string
          p_safe_reply_content: string
          p_source_message_id: string
        }
        Returns: Json
      }
      fail_evaluation: {
        Args: { p_attempt_id: string; p_error: string }
        Returns: Json
      }
      fail_local_evaluation_v1: {
        Args: { p_attempt_id: string; p_error: string }
        Returns: Json
      }
      finalize_local_evaluation_tenant_scope_v1: {
        Args: { p_actor_user_id: string; p_company_id: string }
        Returns: Json
      }
      find_auth_user_by_email: { Args: { p_email: string }; Returns: Json }
      finish_pr6b_kb_finalize_tx: {
        Args: { p_error: string; p_outcome: string; p_publish_state_id: string }
        Returns: Json
      }
      finish_pr6b_kb_sync_tx: {
        Args: {
          p_error: string
          p_remote_ref: string
          p_success: boolean
          p_training_link_id: string
        }
        Returns: Json
      }
      has_company_role: {
        Args: {
          p_company_id: string
          p_role: Database["public"]["Enums"]["app_role"]
          p_user_id: string
        }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      initiate_evaluation: {
        Args: {
          p_contract_version: string
          p_conversation_id: string
          p_initiated_by: string
          p_input_snapshot_hash: string
          p_kb_snapshot_id: string
          p_model_version: string
          p_policy_snapshot_id: string
          p_prompt_version: string
          p_source_deployment: string
        }
        Returns: Json
      }
      initiate_evaluation_v2: {
        Args: {
          p_bundle_hash: string
          p_contract_version: string
          p_conversation_id: string
          p_grounding_manifest: Json
          p_initiated_by: string
          p_input_snapshot_hash: string
          p_kb_snapshot_id: string
          p_model_version: string
          p_policy_snapshot_id: string
          p_prompt_version: string
          p_source_deployment: string
        }
        Returns: Json
      }
      initiate_local_evaluation_v1: {
        Args: {
          p_bundle_hash: string
          p_contract_version: string
          p_conversation_id: string
          p_initiated_by: string
          p_input_snapshot_hash: string
          p_model_version: string
          p_prompt_version: string
          p_source_deployment: string
        }
        Returns: Json
      }
      is_company_member: {
        Args: { p_company_id: string; p_user_id: string }
        Returns: boolean
      }
      is_staff: { Args: { _user_id: string }; Returns: boolean }
      kb_fallback_handoff_tx: {
        Args: {
          p_branch_tag: string
          p_conversation_id: string
          p_safe_reply_content: string
          p_source_message_id: string
        }
        Returns: Json
      }
      pr7_ce_canonical_company: {
        Args: { p_conversation_id: string }
        Returns: string
      }
      reap_stale_evaluation_attempts: {
        Args: { p_older_than?: string }
        Returns: Json
      }
      rebind_local_evaluations_v1: {
        Args: {
          p_actor_user_id: string
          p_company_id: string
          p_rebind_run_id: string
        }
        Returns: Json
      }
      receive_widget_attachment_tx: {
        Args: {
          p_content_type: string
          p_conversation_id: string
          p_mime_type: string
          p_original_name: string
          p_session_token: string
          p_size_bytes: number
          p_storage_path: string
        }
        Returns: Json
      }
      receive_widget_message_tx: {
        Args: {
          p_content: string
          p_conversation_id: string
          p_session_token: string
        }
        Returns: Json
      }
      record_coachai_training_result_tx: {
        Args: {
          p_company_id: string
          p_contract_version: string
          p_decision: string
          p_evaluation_id: string
          p_idempotency_key: string
          p_remote_ref: string
          p_result: Json
        }
        Returns: Json
      }
      required_escalation_clarification_tx: {
        Args: {
          p_clarification_content: string
          p_conversation_id: string
          p_escalation_rule: string
          p_reason_code: string
          p_source_message_id: string
        }
        Returns: Json
      }
      required_escalation_handoff_tx: {
        Args: {
          p_conversation_id: string
          p_escalation_rule: string
          p_priority: string
          p_reason_code: string
          p_safe_reply_content: string
          p_source_message_id: string
        }
        Returns: Json
      }
      return_to_ai_tx: {
        Args: {
          p_actor_agent_id: string
          p_conversation_id: string
          p_expected_owner?: string
          p_expected_status: string
        }
        Returns: Json
      }
      review_evaluation: {
        Args: {
          p_decision: string
          p_evaluation_id: string
          p_expected_conversation_id: string
          p_note?: string
        }
        Returns: Json
      }
      review_local_evaluation_v1: {
        Args: {
          p_decision: string
          p_evaluation_id: string
          p_expected_conversation_id: string
          p_note?: string
        }
        Returns: Json
      }
      rpc_update_agent_profile: {
        Args: {
          p_agent_id: string
          p_avatar_url?: string
          p_display_name?: string
        }
        Returns: Json
      }
      rpc_update_channel_config: {
        Args: {
          p_allowed_origins?: string[]
          p_channel_config_id: string
          p_is_active?: boolean
        }
        Returns: Json
      }
      rpc_update_feedback_config: {
        Args: {
          p_config?: Json
          p_delay_minutes?: number
          p_feedback_config_id: string
          p_is_active?: boolean
        }
        Returns: Json
      }
      rpc_update_widget_config: {
        Args: {
          p_header_title?: string
          p_is_active?: boolean
          p_logo_url?: string
          p_name?: string
          p_placeholder_text?: string
          p_primary_color?: string
          p_welcome_message?: string
          p_widget_config_id: string
        }
        Returns: Json
      }
      s0_handoff_tx: {
        Args: {
          p_conversation_id: string
          p_failure_type: string
          p_safe_reply_content: string
          p_source_message_id: string
        }
        Returns: Json
      }
      safe_add_agent: {
        Args: {
          p_app_role: Database["public"]["Enums"]["app_role"]
          p_caller_id: string
          p_display_name: string
          p_target_user_id: string
        }
        Returns: Json
      }
      safe_change_role: {
        Args: {
          p_caller_id: string
          p_new_app_role: Database["public"]["Enums"]["app_role"]
          p_target_user_id: string
        }
        Returns: Json
      }
      safe_deactivate_agent: {
        Args: { p_caller_id: string; p_target_agent_id: string }
        Returns: Json
      }
      safe_reactivate_agent: {
        Args: {
          p_app_role: Database["public"]["Enums"]["app_role"]
          p_caller_id: string
          p_target_agent_id: string
        }
        Returns: Json
      }
      set_conversation_resolution_tx: {
        Args: {
          p_actor_agent_id: string
          p_actor_user_id: string
          p_company_id: string
          p_conversation_id: string
          p_reason?: string
          p_target_state: string
        }
        Returns: Json
      }
      takeover_conversation_tx: {
        Args: {
          p_agent_id: string
          p_conversation_id: string
          p_expected_owner?: string
          p_expected_status: string
        }
        Returns: Json
      }
      transfer_conversation_tx: {
        Args: {
          p_conversation_id: string
          p_expected_assigned_agent_id: string
          p_from_agent_id: string
          p_reason?: string
          p_to_agent_id: string
        }
        Returns: Json
      }
      verified_human_response: {
        Args: { p_conversation_id: string }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "supervisor" | "agent" | "qa"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "supervisor", "agent", "qa"],
    },
  },
} as const
