import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

export function consoleInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.map(word => word[0]).join("").slice(0,2) : words[0]?.slice(0,2) || "U").toUpperCase();
}
export function useConsoleIdentity() {
  const { user } = useAuth();
  const actorId = user?.id ?? null;
  const [profile, setProfile] = useState<{actorId: string; name: string} | null>(null);
  useEffect(() => {
    let active = true;
    if (!actorId) return;
    void (async () => {
      try {
        const {data,error} = await supabase.auth.getUser();
        if (error || data.user?.id !== actorId) return;
        const result = await supabase.from("agent_profile").select("display_name").eq("user_id",actorId).maybeSingle();
        if (active && !result.error && typeof result.data?.display_name === "string" && result.data.display_name.trim()) setProfile({actorId,name:result.data.display_name.trim()});
      } catch { /* Current-actor email fallback, never another actor's retained profile. */ }
    })();
    return () => { active = false; };
  },[actorId]);
  const name = actorId && profile?.actorId === actorId ? profile.name : user?.email?.split("@")[0] || "Account";
  return { actorId, name, initials: consoleInitials(name) };
}
