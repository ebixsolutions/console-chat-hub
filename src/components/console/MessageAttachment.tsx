import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { FileText, ImageIcon, Loader2, Video } from "lucide-react";
import { getAgentAttachmentUrl } from "@/lib/api/attachments.functions";

export type AttachmentMeta = {
  storage_bucket?: unknown;
  storage_path?: unknown;
  original_name?: unknown;
  mime_type?: unknown;
  size_bytes?: unknown;
};

export function isAttachmentMessage(contentType: unknown): contentType is "image" | "video" | "file" {
  return contentType === "image" || contentType === "video" || contentType === "file";
}

function safeName(metadata: AttachmentMeta | null): string {
  const raw = metadata && typeof metadata.original_name === "string" ? metadata.original_name : "";
  return raw.trim().slice(0, 120) || "attachment";
}

function safeSize(metadata: AttachmentMeta | null): string {
  const bytes = metadata && typeof metadata.size_bytes === "number" ? metadata.size_bytes : null;
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Renders an attachment message. Storage paths are never exposed: the file is
 * read exclusively through a short-lived authenticated signed URL.
 */
export function MessageAttachment({
  messageId,
  contentType,
  metadata,
}: {
  messageId: string;
  contentType: "image" | "video" | "file";
  metadata: AttachmentMeta | null;
}) {
  const fetchUrl = useServerFn(getAgentAttachmentUrl);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(false);

  const load = useCallback(async (): Promise<string | null> => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchUrl({ data: { message_id: messageId } });
      if (!result.ok) {
        setError("Attachment unavailable");
        return null;
      }
      setUrl(result.url);
      return result.url;
    } catch {
      setError("Attachment unavailable");
      return null;
    } finally {
      setLoading(false);
    }
  }, [fetchUrl, messageId]);

  useEffect(() => {
    if (contentType !== "image" || requested.current) return;
    requested.current = true;
    void load();
  }, [contentType, load]);

  const name = safeName(metadata);
  const size = safeSize(metadata);

  if (contentType === "image") {
    return (
      <div className="space-y-1">
        {loading && (
          <div className="flex items-center gap-1 text-xs opacity-70">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading image…
          </div>
        )}
        {url && (
          <img
            src={url}
            alt={name}
            className="max-h-56 max-w-full rounded-md border object-contain"
            loading="lazy"
          />
        )}
        {error && <div className="text-xs text-destructive">{error}</div>}
        <div className="flex items-center gap-1 text-[10px] opacity-70">
          <ImageIcon className="h-3 w-3" />
          <span className="truncate">{name}</span>
          {size && <span>· {size}</span>}
        </div>
      </div>
    );
  }

  const Icon = contentType === "video" ? Video : FileText;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{name}</span>
        {size && <span className="opacity-70">· {size}</span>}
      </div>
      <button
        type="button"
        className="text-[11px] underline"
        disabled={loading}
        onClick={async () => {
          const link = url ?? (await load());
          if (link) window.open(link, "_blank", "noopener,noreferrer");
        }}
      >
        {loading ? "Preparing…" : "Open"}
      </button>
      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}
