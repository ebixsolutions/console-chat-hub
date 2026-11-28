import { useEffect, useRef, useState } from "react";
import { savedResponsesService, type SavedResponse } from "@/lib/api/saved-responses.service";
import { expandSavedResponse } from "@/lib/console/saved-response-variables";
export function SavedResponses({
  conversationId,
  variables,
  onInsert,
}: {
  conversationId: string;
  variables: Record<string, string | null | undefined>;
  onInsert: (text: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [rows, setRows] = useState<SavedResponse[]>([]),
    [query, setQuery] = useState("");
  const [editing, setEditing] = useState<SavedResponse | null>(null),
    [title, setTitle] = useState(""),
    [content, setContent] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const epoch = useRef(0),
    writing = useRef(false),
    createRequest = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    epoch.current++;
    setOpen(false);
    writing.current = false;
    createRequest.current = null;
    setRows([]);
    setEditing(null);
    setTitle("");
    setContent("");
    setQuery("");
    setError("");
    setBusy(false);
    return () => {
      epoch.current++;
    };
  }, [conversationId]);
  const load = async () => {
    const e = epoch.current;
    setBusy(true);
    setError("");
    try {
      const r = await savedResponsesService.run({ action: "list" });
      if (e !== epoch.current) return;
      if (!r.ok) setError(r.error);
      else setRows(r.rows);
    } catch {
      if (e === epoch.current) setError("saved_response_read_failed");
    } finally {
      if (e === epoch.current) setBusy(false);
    }
  };
  const save = async () => {
    if (writing.current) return;
    writing.current = true;
    const e = epoch.current;
    const key = JSON.stringify([title.trim(), content.trim()]);
    if (!editing && createRequest.current?.key !== key)
      createRequest.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const r = await savedResponsesService.run({
        action: "save",
        id: editing?.id,
        revision: editing?.revision,
        create_id: editing ? undefined : createRequest.current?.id,
        title: title.trim(),
        content: content.trim(),
      });
      if (e !== epoch.current) return;
      if (!r.ok) {
        setError(r.error);
        return;
      }
      createRequest.current = null;
      setEditing(null);
      setTitle("");
      setContent("");
      await load();
    } catch {
      if (e === epoch.current) setError("saved_response_save_failed");
    } finally {
      if (e === epoch.current) {
        setBusy(false);
        writing.current = false;
      }
    }
  };
  const remove = async (row: SavedResponse) => {
    if (writing.current) return;
    writing.current = true;
    const e = epoch.current;
    setBusy(true);
    setError("");
    try {
      const r = await savedResponsesService.run({
        action: "delete",
        id: row.id,
        revision: row.revision,
      });
      if (e !== epoch.current) return;
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (editing?.id === row.id) {
        setEditing(null);
        setTitle("");
        setContent("");
      }
      await load();
    } catch {
      if (e === epoch.current) setError("saved_response_delete_failed");
    } finally {
      if (e === epoch.current) {
        setBusy(false);
        writing.current = false;
      }
    }
  };
  return (
    <section aria-label="Saved responses">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setOpen(!open);
          if (!open) void load();
        }}
      >
        Saved Responses
      </button>
      {open && (
        <div className="space-y-2 rounded border p-2">
          <p className="text-xs">
            Your saved responses. Insert adds a draft; review before sending.
          </p>
          <input
            aria-label="Search saved responses"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {error && <p role="alert">{error}</p>}
          <button type="button" disabled={busy} onClick={() => void load()}>
            Refresh saved responses
          </button>
          {rows
            .filter((r) => (r.title + " " + r.content).toLowerCase().includes(query.toLowerCase()))
            .map((r) => (
              <div key={r.id}>
                <b>{r.title}</b>
                <p className="whitespace-pre-wrap">{r.content}</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    try {
                      onInsert(expandSavedResponse(r.content, variables));
                      setError("");
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "saved_response_insert_failed");
                    }
                  }}
                >
                  Insert {r.title}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(r);
                    setTitle(r.title);
                    setContent(r.content);
                  }}
                >
                  Edit {r.title}
                </button>
                <button type="button" disabled={busy} onClick={() => void remove(r)}>
                  Delete {r.title}
                </button>
              </div>
            ))}
          <input
            disabled={busy}
            aria-label="Saved response title"
            maxLength={100}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            disabled={busy}
            aria-label="Saved response content"
            maxLength={4000}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <p className="text-xs">
            Variables: {"{{customer_name}}, {{agent_name}}, {{channel_name}}"}
          </p>
          <button
            type="button"
            disabled={busy || !title.trim() || !content.trim()}
            onClick={() => void save()}
          >
            {editing ? "Save response" : "Add response"}
          </button>
          {editing && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setTitle("");
                setContent("");
              }}
            >
              Cancel edit
            </button>
          )}
        </div>
      )}
    </section>
  );
}
