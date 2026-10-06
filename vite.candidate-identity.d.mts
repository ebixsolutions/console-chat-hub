import type { Plugin } from 'vite';
export interface CandidateIdentity {
  projectId: string;
  head: string;
  tree: string;
  modified: boolean;
  sourceSha256: string;
  buildProfile: 'production' | 'nonproduction';
  sourceBackendRef: string;
  backendRuntimeVerified: false;
}
export function candidateIdentity(nonproduction: boolean): Readonly<CandidateIdentity>;
export function candidateIdentityPlugin(identity: Readonly<CandidateIdentity>): Plugin;
