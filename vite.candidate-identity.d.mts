import type { Plugin } from 'vite';
export interface CandidateIdentity {
  projectId: string;
  identitySource: 'git' | 'build_env' | 'source_fingerprint';
  head: string | null;
  tree: string | null;
  modified: boolean | null;
  buildEnvIdentity: null;
  buildEnvMetadataStatus: 'unavailable' | 'ignored_unverified_provenance';
  sourceManifestVersion: string;
  sourceFileCount: number;
  sourceSha256: string;
  buildProfile: 'production' | 'nonproduction';
  sourceBackendRef: string;
  backendRuntimeVerified: false;
}
export function candidateIdentity(nonproduction: boolean, options?: {root?: string; env?: NodeJS.ProcessEnv}): Readonly<CandidateIdentity>;
export function sourceFingerprint(root?: string): Pick<CandidateIdentity, 'sourceSha256' | 'sourceManifestVersion' | 'sourceFileCount'>;
export function renderCandidateIdentity(identity: Readonly<CandidateIdentity>): string;
export function candidateIdentityPlugin(identity: Readonly<CandidateIdentity>): Plugin;
