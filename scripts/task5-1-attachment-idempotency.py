from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p=Path(path); s=p.read_text(); n=s.count(old)
    if n != 1: raise SystemExit(f'{path}: expected one match, got {n}')
    p.write_text(s.replace(old,new,1))

recv='supabase/functions/receive-widget-message/index.ts'
replace_once(recv,
'''      const { data: txData, error: txError } = await supabase.rpc("receive_widget_attachment_tx", {
        p_conversation_id: conversation_id,
        p_session_token: session_token,
        p_content_type: attachmentType(attachment.type),
        p_storage_path: storagePath,
        p_original_name: attachment.name.slice(0, 255),
        p_mime_type: attachment.type,
        p_size_bytes: attachment.size,
      });
      if (txError || String(txData?.result ?? "") !== "success") {
        await supabase.storage.from("widget-attachments").remove([storagePath]);
        return json({ success: false, error: "attachment_transaction_failed" }, 500);
      }
      return json({ success: true, data: { message_id: String(txData.message_id), content_type: attachmentType(attachment.type), ai_reply_pending: false } });''',
'''      const attachmentClientId = typeof client_message_id === "string" ? client_message_id : crypto.randomUUID();
      const { data: txData, error: txError } = await supabase.rpc("receive_widget_attachment_tx", {
        p_conversation_id: conversation_id,
        p_session_token: session_token,
        p_content_type: attachmentType(attachment.type),
        p_storage_path: storagePath,
        p_original_name: attachment.name.slice(0, 255),
        p_mime_type: attachment.type,
        p_size_bytes: attachment.size,
        p_client_message_id: attachmentClientId,
      });
      const attachmentResult = String(txData?.result ?? "");
      if (attachmentResult === "idempotent") {
        await supabase.storage.from("widget-attachments").remove([storagePath]);
        return json({ success: true, data: { message_id: String(txData.message_id), content_type: attachmentType(attachment.type), ai_reply_pending: false, idempotent: true } });
      }
      if (txError || attachmentResult !== "success") {
        await supabase.storage.from("widget-attachments").remove([storagePath]);
        return json({ success: false, error: "attachment_transaction_failed" }, 500);
      }
      return json({ success: true, data: { message_id: String(txData.message_id), content_type: attachmentType(attachment.type), ai_reply_pending: false, idempotent: false } });''')

widget='public/widget/chat.js'
replace_once(widget,
'''    var form = new FormData();
    form.append("conversation_id", state.conversationId);
    form.append("session_token", state.sessionToken);
    form.append("file", file);''',
'''    var form = new FormData();
    form.append("conversation_id", state.conversationId);
    form.append("session_token", state.sessionToken);
    form.append("client_message_id", createClientMessageId());
    form.append("file", file);''')

s=Path(widget).read_text()
if 'function createClientMessageId()' not in s:
    anchor='''  function uploadAttachment(file) {'''
    helper='''  function createClientMessageId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

'''
    if s.count(anchor)!=1: raise SystemExit('widget upload anchor mismatch')
    Path(widget).write_text(s.replace(anchor,helper+anchor,1))

for path, needles in {
  recv:['p_client_message_id: attachmentClientId','attachmentResult === "idempotent"','remove([storagePath])'],
  widget:['form.append("client_message_id", createClientMessageId())','function createClientMessageId()','function uploadAttachment(file)'],
}.items():
    t=Path(path).read_text()
    for needle in needles:
        if needle not in t: raise SystemExit(f'{path}: missing {needle}')
print('TASK5_1_ATTACHMENT_IDEMPOTENCY_PATCH=PASS')
