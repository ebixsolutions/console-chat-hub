#!/bin/bash
set -Eeuo pipefail
P="src/routes/_authenticated/console.widget-preview.tsx"
C="public/widget/chat.js"
E="supabase/functions/receive-widget-message/index.ts"
S="sql/pr15/pr15_widget_attachment.sql"
R="sql/pr15/pr15_widget_attachment.rollback.sql"
fail=0
pass(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }
for f in "$P" "$C" "$E" "$S" "$R"; do [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }; done

has "$P" 'aria-label="Conversation History"' "Preview history restored"
has "$P" 'aria-label="New Conversation"' "Preview new conversation restored"
has "$P" '<Plus className=' "Preview plus menu restored"
has "$P" '<Image className=' "Preview Image action"
has "$P" '<Video className=' "Preview Video action"
has "$P" '<Paperclip className=' "Preview File action"
has "$P" '<UserRound className=' "Preview Human action"
not_has "$P" '+ Request Human Support' "standalone human action removed"

has "$C" 'nx-my-tickets-btn' "Production history retained"
has "$C" 'nx-new-conversation-btn' "Production new conversation restored"
has "$C" '{ key: "image"' "Production Image action"
has "$C" '{ key: "video"' "Production Video action"
has "$C" '{ key: "file"' "Production File action"
has "$C" '{ key: "human"' "Production Human action"
has "$C" 'fetch(apiBase + "/receive-widget-message"' "Production upload uses existing Edge endpoint"
not_has "$C" 'File upload hidden until real backend support is available' "obsolete hidden upload removed"

has "$E" 'multipart/form-data' "receive-widget-message supports multipart"
has "$E" 'validateWidgetOrigin' "origin validation retained"
has "$E" '.eq("visitor_session_id",sessionScope.id)' "conversation/session binding"
has "$E" 'MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024' "10 MB size limit"
has "$E" 'ALLOWED_ATTACHMENT_MIME' "MIME allowlist"
has "$E" 'receive_widget_attachment_tx' "atomic attachment RPC"
has "$E" 'remove([storagePath])' "orphan object cleanup"
has "$E" 'receive_widget_message_tx' "text path retained"
has "$E" 'EdgeRuntime.waitUntil(generateReplyTask)' "AI reply handoff retained"

has "$S" "'widget-attachments','widget-attachments',false" "private bucket"
has "$S" 'content_type,metadata,status' "attachment message metadata"
has "$S" 'REVOKE ALL ON FUNCTION public.receive_widget_attachment_tx' "public/authenticated denied"
has "$S" 'GRANT EXECUTE ON FUNCTION public.receive_widget_attachment_tx' "service role execute only"
has "$R" 'rollback_blocked_widget_attachments_not_empty' "safe non-destructive rollback"

node --check "$C" >/dev/null 2>&1 && pass "chat.js parser" || bad "chat.js parser"

if [ "$fail" -ne 0 ]; then
  echo "PR15 WIDGET ACTIONS / ATTACHMENTS / HANDOFF STATUS: FAIL"
  exit 1
fi
echo "PR15 WIDGET ACTIONS / ATTACHMENTS / HANDOFF STATUS: PASS"
