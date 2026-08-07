/**
 * useEffectiveRole — console permission-guard role source
 *
 * Reads Demo Role Override context first (provided by EffectiveRoleProvider
 * wrapping <Outlet /> in ConsoleLayout). Falls back to production
 * useCurrentRole() when the provider is absent.
 *
 * Implementation uses standard React Context (createContext / useContext),
 * NOT router-specific APIs like useOutletContext. This makes the hook
 * router-agnostic — it works regardless of whether the project uses
 * react-router-dom, TanStack Router, or any other routing library.
 *
 * P1 Rescue: this hook is the sanctioned way for console child pages to
 * read their guard role. Direct calls to useCurrentRole() from child
 * pages in the settings surface are being replaced by this hook.
 *
 * useCurrentRole() itself is NOT modified.
 *
 * Approved: Director ruling 2026-07-03
 */

import { createContext, useContext, type ReactNode } from "react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import type { ConsoleOutletContext, EffectiveRole } from "@/types/demoRole";

// --- Context (not exported — consumers use the hook or provider below) ---

const EffectiveRoleContext = createContext<ConsoleOutletContext | undefined>(undefined);

// --- Provider (used by ConsoleLayout to wrap <Outlet />) ---

export function EffectiveRoleProvider({ value, children }: { value: ConsoleOutletContext; children: ReactNode }) {
  return <EffectiveRoleContext.Provider value={value}>{children}</EffectiveRoleContext.Provider>;
}

// --- Hook (used by child pages to read effective role) ---

export type UseEffectiveRoleResult = {
  role: EffectiveRole | null;
  loading: boolean;
  /** 'demo' when the value came from EffectiveRoleProvider;
   *  'production' when it fell back to useCurrentRole(). */
  source: "demo" | "production";
};

export function useEffectiveRole(): UseEffectiveRoleResult {
  // useContext returns undefined when no ancestor Provider exists.
  const ctx = useContext(EffectiveRoleContext);
  const production = useCurrentRole();

  if (ctx?.effectiveRole) {
    return {
      role: ctx.effectiveRole,
      loading: false,
      source: "demo",
    };
  }

  // Production fallback: AppRole ⊂ EffectiveRole, cast is safe.
  return {
    role: (production.role as EffectiveRole | null) ?? null,
    loading: production.loading,
    source: "production",
  };
}
// --- Console language hook (Dev22-G) ---
// Reads lang from the same EffectiveRoleContext without changing
// useEffectiveRole(). Separation of concerns: useConsoleLang() for
// language, useEffectiveRole() for role/loading.

export function useConsoleLang(): "en" | "zh" {
  const ctx = useContext(EffectiveRoleContext);
  return ctx?.lang === "zh" ? "zh" : "en";
}
