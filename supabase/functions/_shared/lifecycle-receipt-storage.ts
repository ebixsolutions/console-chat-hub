import { isConversationCommerceState, type CommerceEntity,
  type ConversationCommerceState } from "./commerce-state-contract.ts";
import { sameCanonicalJson } from "./canonical-json.ts";
import { encodeBoundedJsonStorage, decodeBoundedJsonStorage,
  type BoundedJsonStorage } from "./bounded-json-storage.ts";
import { b2JourneyTransactionBoundary, verifyEntityLifecycleTransition,
  type B2TrustedLifecycleCommit } from "./b2-journey-progress-contract.ts";

/** Lossless storage only. B2 continues to receive the complete original proof.
 * A lifecycle changes status/provenance, focus and two conversion ID lists;
 * all other state must be identical under verifyEntityLifecycleTransition.
 * Store the common state once instead of embedding two large copies in Memory.
 */
export interface CompactLifecycleReceipt extends Omit<B2TrustedLifecycleCommit, "previous_state"> {
  storage_encoding: "lifecycle-state-delta-v1";
  previous_state_delta: {
    entities: Array<Pick<CommerceEntity, "entity_id" | "status" | "provenance">>;
    current_topic: ConversationCommerceState["current_topic"];
    tentative_entity_ids: string[];
    cancelled_entity_ids: string[];
  };
}
export interface PackedLifecycleReceipt extends Omit<CompactLifecycleReceipt, "storage_encoding" | "committed_state"> {
  storage_encoding: "lifecycle-state-table-v1";
  committed_state_json: BoundedJsonStorage;
}
export type StoredLifecycleReceipt = B2TrustedLifecycleCommit | CompactLifecycleReceipt | PackedLifecycleReceipt;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(id => typeof id === "string" && id.length > 0) &&
    new Set(value).size === value.length;
}
function provenance(value: unknown): value is CommerceEntity["provenance"] {
  if (!record(value) || !["customer", "human_agent", "kb", "system", "tool", "derived"].includes(String(value.source_type)) ||
    typeof value.source_type !== "string" ||
    Object.keys(value).some(key => !["source_type", "source_message_id", "source_reference", "recorded_at"].includes(key))) return false;
  return ["source_message_id", "source_reference", "recorded_at"].every(key =>
    !Object.hasOwn(value, key) || value[key] === null || typeof value[key] === "string");
}

/** A storage encoding never supplies independent authority. Expand it, prove
 * the exact transition, then let the existing Memory/current-source/B2 checks
 * bind the resulting full receipt to the live canonical row and reply.
 */
export function readStoredLifecycleReceipt(value: unknown): B2TrustedLifecycleCommit | null {
  try {
    if (record(value) && value.storage_encoding === "lifecycle-state-table-v1") {
      if (Object.hasOwn(value, "committed_state") || Object.hasOwn(value, "previous_state")) return null;
      const decoded = decodeBoundedJsonStorage(value.committed_state_json);
      if (!decoded.ok || !isConversationCommerceState(decoded.value)) return null;
      const { committed_state_json: _encoded, ...common } = value;
      return readStoredLifecycleReceipt({ ...common, storage_encoding: "lifecycle-state-delta-v1",
        committed_state: decoded.value });
    }
    if (!record(value) || value.contract !== "entity-lifecycle-commit-v1" ||
      typeof value.company_id !== "string" || !value.company_id ||
      typeof value.source_message_id !== "string" || !value.source_message_id ||
      typeof value.source_text !== "string" || !value.source_text ||
      typeof value.reply !== "string" || !value.reply ||
      !Number.isSafeInteger(value.previous_revision) || Number(value.previous_revision) < 0 ||
      !Number.isSafeInteger(value.committed_revision) ||
      Number(value.previous_revision) + 1 !== value.committed_revision ||
      !ids(value.target_entity_ids) || !value.target_entity_ids.length ||
      !Array.isArray(value.plans) || !value.plans.length ||
      !isConversationCommerceState(value.committed_state)) return null;
    let receipt: B2TrustedLifecycleCommit;
    if (Object.hasOwn(value, "storage_encoding")) {
      if (value.storage_encoding !== "lifecycle-state-delta-v1" ||
        Object.hasOwn(value, "previous_state") || !record(value.previous_state_delta)) return null;
      const delta = value.previous_state_delta;
      if (!onlyKeys(delta, ["entities", "current_topic", "tentative_entity_ids", "cancelled_entity_ids"]) ||
        !Array.isArray(delta.entities) || delta.entities.length !== value.target_entity_ids.length ||
        !(delta.current_topic === null || typeof delta.current_topic === "string") ||
        !ids(delta.tentative_entity_ids) || !ids(delta.cancelled_entity_ids)) return null;
      const previous = structuredClone(value.committed_state);
      const seen = new Set<string>();
      for (const row of delta.entities) {
        if (!record(row) || !onlyKeys(row, ["entity_id", "status", "provenance"]) ||
          typeof row.entity_id !== "string" || !value.target_entity_ids.includes(row.entity_id) ||
          seen.has(row.entity_id) ||
          typeof row.status !== "string" ||
          !["researching", "tentative", "confirmed", "deferred", "cancelled"].includes(row.status) ||
          !provenance(row.provenance)) return null;
        const matches = previous.entities.filter(entity => entity.entity_id === row.entity_id);
        if (matches.length !== 1) return null;
        seen.add(row.entity_id);
        matches[0].status = row.status as CommerceEntity["status"];
        matches[0].provenance = structuredClone(row.provenance);
      }
      previous.current_topic = delta.current_topic;
      previous.conversion.tentative_entity_ids = structuredClone(delta.tentative_entity_ids);
      previous.conversion.cancelled_entity_ids = structuredClone(delta.cancelled_entity_ids);
      const { storage_encoding: _encoding, previous_state_delta: _delta, ...common } = value;
      receipt = { ...structuredClone(common), previous_state: previous } as unknown as B2TrustedLifecycleCommit;
    } else {
      if (Object.hasOwn(value, "previous_state_delta") || !isConversationCommerceState(value.previous_state)) return null;
      receipt = structuredClone(value) as unknown as B2TrustedLifecycleCommit;
    }
    const transition = verifyEntityLifecycleTransition(receipt.source_text, receipt.previous_state,
      receipt.committed_state, receipt.source_message_id);
    if (!transition.valid || !sameCanonicalJson(transition.plans, receipt.plans) ||
      !sameCanonicalJson(transition.targetIds, receipt.target_entity_ids) ||
      !sameCanonicalJson(receipt.transaction_before, b2JourneyTransactionBoundary(receipt.previous_state)) ||
      !sameCanonicalJson(receipt.transaction_after, b2JourneyTransactionBoundary(receipt.committed_state)) ||
      !sameCanonicalJson(receipt.transaction_before, receipt.transaction_after)) return null;
    return receipt;
  } catch {
    return null;
  }
}

export function compactLifecycleReceipt(receipt: B2TrustedLifecycleCommit): CompactLifecycleReceipt | null {
  const full = readStoredLifecycleReceipt(receipt);
  if (!full) return null;
  const { previous_state, ...common } = full;
  const compact: CompactLifecycleReceipt = {
    ...common, storage_encoding: "lifecycle-state-delta-v1",
    previous_state_delta: {
      entities: full.target_entity_ids.map(id => {
        const entity = previous_state.entities.find(item => item.entity_id === id)!;
        return { entity_id: id, status: entity.status, provenance: structuredClone(entity.provenance) };
      }),
      current_topic: previous_state.current_topic,
      tentative_entity_ids: structuredClone(previous_state.conversion.tentative_entity_ids),
      cancelled_entity_ids: structuredClone(previous_state.conversion.cancelled_entity_ids),
    },
  };
  const expanded = readStoredLifecycleReceipt(compact);
  return expanded && sameCanonicalJson(expanded, full) ? compact : null;
}

/** Larger ordinary journeys may contain repeated correction/source rows.
 * Intern their JSON structure without omitting a field or weakening equality.
 */
export function packLifecycleReceipt(receipt: B2TrustedLifecycleCommit): PackedLifecycleReceipt | null {
  const compact = compactLifecycleReceipt(receipt);
  if (!compact) return null;
  const encoded = encodeBoundedJsonStorage(compact.committed_state);
  if (!encoded) return null;
  const { committed_state: _state, storage_encoding: _encoding, ...common } = compact;
  const packed: PackedLifecycleReceipt = { ...common, storage_encoding: "lifecycle-state-table-v1",
    committed_state_json: encoded };
  const expanded = readStoredLifecycleReceipt(packed);
  return expanded && sameCanonicalJson(expanded, receipt) ? packed : null;
}
