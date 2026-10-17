import type { ConfigEnv } from 'vite';
export const PREVIEW_HOST: string;
export const LIVE_PREVIEW_HOST: string;
export function resolveConsoleEnvironment(
  configuration: Pick<ConfigEnv, 'command' | 'mode'>,
  environment: Record<string, string | undefined>,
): 'production' | 'nonproduction' | undefined;
