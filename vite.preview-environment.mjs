// Server-process configuration only. Never inspect a request or browser state.
export const PREVIEW_HOST = 'id-preview--4dbf593e-577e-4af4-a553-460441c34473.lovable.app';
export const LIVE_PREVIEW_HOST = '4dbf593e-577e-4af4-a553-460441c34473.lovableproject.com';

export function resolveConsoleEnvironment({ command, mode }, environment) {
  const requested = environment.C3_CONSOLE_ENV;
  if (requested && !['production', 'nonproduction'].includes(requested)) {
    throw new Error('Unknown C3 Console environment');
  }
  // The existing project's normal Preview has one Director-approved authority.
  // Explicit isolated offline builds remain available for preserved evidence.
  const host = environment.LOVABLE_PREVIEW_HOST?.trim();
  const sandbox = environment.LOVABLE_SANDBOX === '1' || Boolean(environment.DEV_SERVER__PROJECT_PATH);
  const previewStartup = (command === 'serve' || command === 'build' && mode === 'development') && (sandbox || Boolean(host));
  if (previewStartup) {
    if (host && ![PREVIEW_HOST, LIVE_PREVIEW_HOST].includes(host)) {
      throw new Error('C3 Preview startup has an unapproved project host');
    }
    if (requested === 'nonproduction') {
      throw new Error('C3 unified Preview cannot use nonproduction authority');
    }
    return 'production';
  }
  return requested;
}
