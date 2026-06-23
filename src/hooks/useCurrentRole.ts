import { useEffect, useState } from "react";
import { authService, type AppRole } from "@/lib/api/config.service";

export function useCurrentRole() {
  const [role, setRole] = useState<AppRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    authService.getCurrentUserRole().then((r) => {
      if (!active) return;
      setRole(r);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  return { role, loading };
}
