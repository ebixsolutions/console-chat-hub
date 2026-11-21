/** One identity per pending draft; retain it on failure, clear only on confirmed success. */
export class ReplyRequest {
  private pending: { conversationId: string; content: string; id: string } | null = null;
  body(conversationId: string, content: string) {
    content = content.trim();
    if (
      !this.pending ||
      this.pending.conversationId !== conversationId ||
      this.pending.content !== content
    ) {
      this.pending = { conversationId, content, id: crypto.randomUUID() };
    }
    return { conversation_id: conversationId, content, client_request_id: this.pending.id };
  }
  confirmed(clientRequestId: string) {
    if (this.pending?.id === clientRequestId) this.pending = null;
  }
}
