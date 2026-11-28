import { useEffect, useRef, useState } from "react";
type Target = { id: string; revision: string; label: string; available: boolean };
/** Explicit operator intent only. Existing per-ticket server admission is unchanged. */
export function CeBatchControls({
  targets,
  allowed,
  disabled,
  execute,
  onBusy,
}: {
  targets: Target[];
  allowed: boolean;
  disabled: boolean;
  execute: (target: Target) => Promise<boolean>;
  onBusy: (busy: boolean) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  const stop = useRef(false),
    active = useRef(false),
    live = useRef({ targets, allowed });
  live.current = { targets, allowed };
  useEffect(
    () => () => {
      stop.current = true;
    },
    [],
  );
  useEffect(() => {
    if (!allowed) {
      stop.current = true;
      setSelected([]);
    }
  }, [allowed]);
  if (!allowed) return null;
  const run = async () => {
    if (active.current || disabled || !live.current.allowed) return;
    const captured = targets
      .filter((t) => selected.includes(t.id) && t.available)
      .map((t) => ({ ...t }));
    if (!captured.length) return;
    active.current = true;
    stop.current = false;
    setBusy(true);
    onBusy(true);
    setStatus("");
    let attempted = 0,
      accepted = 0;
    try {
      for (const target of captured) {
        if (stop.current || !live.current.allowed) break;
        const current = live.current.targets.find((t) => t.id === target.id);
        if (!current?.available || current.revision !== target.revision) {
          setStatus("Batch stopped: eligibility changed. Refresh before another run.");
          return;
        }
        attempted++;
        // false includes rejection or unknown transport outcome: never retry/continue.
        if (!(await execute(target))) {
          setStatus(
            `Batch stopped after ${attempted} attempt(s); ${accepted} accepted. No automatic retry.`,
          );
          return;
        }
        accepted++;
      }
      setStatus(
        `${accepted} request(s) accepted of ${attempted} attempted. Acceptance does not mean evaluation completed.`,
      );
    } catch {
      setStatus(
        `Batch stopped after ${attempted} attempt(s): outcome unknown. No automatic retry.`,
      );
    } finally {
      active.current = false;
      setBusy(false);
      setSelected([]);
      onBusy(false);
    }
  };
  return (
    <section aria-label="Batch evaluation" className="space-y-2 rounded border p-2 text-xs">
      <p>
        Batch evaluation uses AI. Select eligible conversations; each request keeps the existing
        server authorization and usage limits.
      </p>
      {targets.map((t) => (
        <label key={t.id} className="block">
          <input
            type="checkbox"
            aria-label={`Evaluate ${t.label}`}
            checked={selected.includes(t.id)}
            disabled={busy || disabled || !t.available}
            onChange={(e) =>
              setSelected((s) =>
                e.target.checked
                  ? [...s.filter((id) => id !== t.id), t.id]
                  : s.filter((id) => id !== t.id),
              )
            }
          />
          {t.label}
          {!t.available ? " (unavailable)" : ""}
        </label>
      ))}
      <button
        type="button"
        disabled={busy || disabled || !targets.some((t) => t.available && selected.includes(t.id))}
        onClick={() => void run()}
      >
        Run selected evaluations
      </button>
      {busy && (
        <button
          type="button"
          onClick={() => {
            stop.current = true;
            setStatus("Stopping after the current request; its outcome is retained.");
          }}
        >
          Stop after current request
        </button>
      )}
      {status && <p role="status">{status}</p>}
    </section>
  );
}
