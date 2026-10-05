// Server-process configuration only. Never inspect a request or browser state.
export const PREVIEW_HOST = 'id-preview--4dbf593e-577e-4af4-a553-460441c34473.lovable.app';

export function resolveConsoleEnvironment({ command, mode }, environment) {
  const requested = environment.C3_CONSOLE_ENV;
  if (requested && !['production', 'nonproduction'].includes(requested)) {
    throw new Error('Unknown C3 Console environment');
  }
  // These are the same process markers used by the installed Lovable Vite
  // launcher. A production build never inherits the automatic dev selection.
  const host = environment.LOVABLE_PREVIEW_HOST?.trim();
  const sandbox = environment.LOVABLE_SANDBOX === '1' || Boolean(environment.DEV_SERVER__PROJECT_PATH);
  const previewStartup = (command === 'serve' || command === 'build' && mode === 'development') && (sandbox || Boolean(host));
  if (previewStartup) {
    if (host && host !== PREVIEW_HOST) {
      throw new Error('C3 Preview startup has an unapproved project host');
    }
    if (requested === 'production') {
      throw new Error('C3 Preview startup cannot use production authority');
    }
    return 'nonproduction';
  }
  return requested;
}
