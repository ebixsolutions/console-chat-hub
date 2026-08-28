import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Image as ImageIcon, Loader2, Paperclip, Smile } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import {
  ALLOWED_ATTACHMENT_MIME,
  MAX_ATTACHMENT_BYTES,
  sendAgentAttachment,
  type AgentAttachmentSendResult,
} from "@/lib/api/attachments.functions";

const EMOJI_SET = [
  "😀", "😊", "😉", "🙏", "👍", "👏", "🙌", "💪",
  "🎉", "✅", "❗", "❓", "⏰", "📎", "📄", "🔍",
  "😅", "😔", "😢", "😡", "❤️", "⭐", "🚀", "🤝",
];

const IMAGE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";
const FILE_ACCEPT = ALLOWED_ATTACHMENT_MIME.join(",");
const TAKEOVER_RETRY_ERRORS = new Set([
  "takeover_required",
  "conversation_owned_by_another_agent",
  "human_control_required",
]);

/** Emoji picker that inserts at the textarea caret position. */
export function EmojiPickerButton({
  onInsert,
  disabled,
}: {
  onInsert: (emoji: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Insert emoji"
          title="Insert emoji"
          disabled={disabled}
          className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
        >
          <Smile className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <div className="grid grid-cols-8 gap-1">
          {EMOJI_SET.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="rounded p-1 text-base hover:bg-muted"
              onClick={() => {
                onInsert(emoji);
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Insert text at the caret of a controlled textarea. */
export function insertAtCaret(
  textarea: HTMLTextAreaElement | null,
  current: string,
  insertion: string,
): { value: string; caret: number } {
  const start = textarea?.selectionStart ?? current.length;
  const end = textarea?.selectionEnd ?? current.length;
  const value = current.slice(0, start) + insertion + current.slice(end);
  return { value, caret: start + insertion.length };
}

/**
 * Image + file attachment buttons.
 *
 * Control semantics intentionally mirror text Send:
 *   1. try authenticated server preflight/send;
 *   2. if human control is required, ask the agent to take over;
 *   3. execute canonical take-over-conversation;
 *   4. retry the exact file once only after takeover succeeds.
 *
 * The server and transactional RPC remain authoritative, so races after the UI
 * confirmation still fail safely and never create a customer-visible message.
 */
export function AttachmentButtons({
  conversationId,
  disabled,
  onSent,
}: {
  conversationId: string | null;
  disabled?: boolean;
  onSent: () => void | Promise<void>;
}) {
  const upload = useServerFn(sendAgentAttachment);
  const [busy, setBusy] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function uploadOnce(file: File, conversationIdValue: string): Promise<AgentAttachmentSendResult> {
    const form = new FormData();
    form.set("conversation_id", conversationIdValue);
    form.set("file", file);
    return await upload({ data: form });
  }

  async function takeOverConversation(conversationIdValue: string): Promise<boolean> {
    const { data, error } = await supabase.functions.invoke("take-over-conversation", {
      body: { conversation_id: conversationIdValue },
    });
    if (error || (data && typeof data === "object" && "error" in data && data.error)) {
      toast.error("Take over failed. Attachment not sent.");
      return false;
    }
    return true;
  }

  async function handleFile(file: File | undefined | null) {
    if (!file || !conversationId) return;
    if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
      toast.error("File too large (max 10 MB)");
      return;
    }
    if (!(ALLOWED_ATTACHMENT_MIME as readonly string[]).includes(file.type)) {
      toast.error("Unsupported file type");
      return;
    }

    setBusy(true);
    try {
      let result = await uploadOnce(file, conversationId);

      if (!result.ok && TAKEOVER_RETRY_ERRORS.has(result.error_type)) {
        const confirmed = window.confirm(
          "Take Over Conversation?\n\nThis conversation is not currently under your control. Take over before sending this attachment?",
        );
        if (!confirmed) return;

        const takenOver = await takeOverConversation(conversationId);
        if (!takenOver) return;

        // Exactly one retry. The server performs fresh tenant/control checks and
        // the RPC locks the conversation before committing the message.
        result = await uploadOnce(file, conversationId);
      }

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success("Attachment sent");
      await onSent();
    } catch {
      toast.error("Attachment upload failed");
    } finally {
      setBusy(false);
    }
  }

  const blocked = disabled || busy || !conversationId;

  return (
    <>
      <input
        ref={imageInput}
        type="file"
        accept={IMAGE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void handleFile(e.target.files?.[0]);
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept={FILE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void handleFile(e.target.files?.[0]);
          e.currentTarget.value = "";
        }}
      />
      <button
        type="button"
        aria-label="Send image"
        title="Send image"
        disabled={blocked}
        onClick={() => imageInput.current?.click()}
        className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
      </button>
      <button
        type="button"
        aria-label="Attach file"
        title="Attach file"
        disabled={blocked}
        onClick={() => fileInput.current?.click()}
        className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
      >
        <Paperclip className="h-4 w-4" />
      </button>
    </>
  );
}
