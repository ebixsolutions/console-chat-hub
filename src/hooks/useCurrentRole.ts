import { useEffect, useState } from "react";
import { authService, type AppRole } from "@/lib/api/config.service";
import { useAuth } from "@/hooks/useAuth";

export function useCurrentRole() {
  const { user, loading: authLoading } = useAuth();
  const actorId = user?.id ?? null;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    actorId: string | null;
    revision: number;
    role: AppRole | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    if (authLoading || !actorId) { setResult(null); return; }
    // Run outside the Auth callback. Never retain another actor's UI role.
    void authService.getCurrentUserRole().then(
      (role) => {
        if (active) setResult({ actorId, revision, role, error: null });
      },
      () => {
        if (active) setResult({ actorId, revision, role: null, error: "role_lookup_failed" });
      },
    );
    return () => { active = false; };
  }, [actorId, authLoading, revision]);

  const current = !authLoading && actorId && result?.actorId === actorId && result.revision === revision;
  return {
    actorId,
    role: current ? result.role : null,
    loading: authLoading || Boolean(actorId && !current),
    error: current ? result.error : null,
    retry: () => setRevision((value) => value + 1),
  };
}
