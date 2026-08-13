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
          slug: string
        }
        Insert: {
          created_at?: string
          display_name: string
          external_tenant_id: string
          external_workspace_id: string
          id?: string
          is_active?: boolean
          slug: string
        }
        Update: {
          created_at?: string
          display_name?: string
          external_tenant_id?: string
          external_workspace_id?: string
          id?: string
          is_active?: boolean
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
          grounding_manifest: Json | null
          id: string
          initiated_by: string
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
          grounding_manifest?: Json | null
          id?: string
          initiated_by: string
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
          grounding_manifest?: Json | null
          id?: string
          initiated_by?: string
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
          id: string
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
          id?: string
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
          id?: string
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
          company_id: string | null
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
          company_id?: string | null
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
          company_id?: string | null
          config?: Json | null
          created_at?: string | null
          delay_minutes?: number | null
          id?: string
          is_active?: boolean | null
          name?: string
          trigger_event?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "feedback_automation_config_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "company"
            referencedColumns: ["id"]
          },
        ]
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
      ce_company_elevated: { Args: { p_company_id: string }; Returns: boolean }
      ce_company_read: { Args: { p_company_id: string }; Returns: boolean }
      ce_is_flag_enabled: { Args: { p_key: string }; Returns: boolean }
      ce_purge_expired_snapshots: { Args: never; Returns: Json }
      check_conv_assignment_invariant: {
        Args: { p_conv_id: string }
        Returns: undefined
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
      find_auth_user_by_email: { Args: { p_email: string }; Returns: Json }
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
      reap_stale_evaluation_attempts: {
        Args: { p_older_than?: string }
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
