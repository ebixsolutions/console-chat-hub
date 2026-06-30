// C1-A: Pure contract definition. No execution logic. Not imported by any production file.

export interface CoachAIAdapterRequest {
  include_content: boolean;
  conversation_id?: string;
}

export interface CoachAIAdapterResponse {
  success: boolean;
  content?: string;
  version_id?: string;
  version_label?: string;
  prompt_hash?: string;
  error_type?: string;
}
