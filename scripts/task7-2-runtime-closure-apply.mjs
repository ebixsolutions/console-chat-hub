import fs from "node:fs";

const path = "supabase/functions/_shared/escalation-shadow.ts";
let source = fs.readFileSync(path, "utf8");

const oldHelper = `function hasCeProvenance(input: EscalationShadowInput): boolean {
  return Boolean(
    input.expected_tenant_id &&
    input.sentiment_provider_version?.trim() &&
    input.sentiment_evaluation_id?.trim(),
  );
}`;

const newHelper = `type SentimentProvenanceKind = "current_turn" | "conversation_evaluation" | "invalid";

function resolveSentimentProvenance(input: EscalationShadowInput): SentimentProvenanceKind {
  const tenant = input.expected_tenant_id?.trim();
  const provider = input.sentiment_provider_version?.trim();
  if (!tenant || !provider) return "invalid";

  if (input.sentiment_evaluation_id?.trim()) return "conversation_evaluation";

  // Current-turn emotion is produced synchronously by the deterministic local
  // classifier before a new CE row can exist. It is advisory-only, so tenant +
  // the frozen classifier provider version is sufficient provenance. Historical
  // CE-derived trend data still requires a concrete evaluation id below.
  if (provider.split("+").some((part) => part.trim().startsWith("current-turn-emotion-v1.0"))) {
    return "current_turn";
  }
  return "invalid";
}`;

if (!source.includes(oldHelper)) throw new Error("Task 7.2 baseline mismatch: hasCeProvenance");
source = source.replace(oldHelper, newHelper);

const startMarker = `  // CE signals fail closed unless tenant + provider version + evaluation id are\n`;
const endMarker = `  if (\n    typeof input.conversation_duration_sec === "number"`;
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error("Task 7.2 baseline mismatch: CE provenance block");

const newBlock = `  // Current-turn emotion is available before CE can complete. It may influence
  // advisory R3 immediately, but can never become a required handoff. Historical
  // CE emotion/trend requires tenant + provider + concrete evaluation lineage.
  const sentimentProvenance = resolveSentimentProvenance(input);
  const ceSignalPresent =
    input.anger_flag === true ||
    typeof input.sentiment_score === "number" ||
    Array.isArray(input.sentiment_trend) ||
    input.sentiment_recovered_same_turn === true;

  if (ceSignalPresent && sentimentProvenance === "invalid") {
    providerWarnings.push("CE_ADVISORY_SIGNAL_PROVENANCE_INCOMPLETE");
  }

  if (ceSignalPresent && sentimentProvenance !== "invalid") {
    const signalSource = sentimentProvenance === "current_turn"
      ? "local_classifier"
      : "conversation_evaluation";
    const ceMeta = {
      provider_version: input.sentiment_provider_version,
      reason: sentimentProvenance === "current_turn"
        ? "current_turn_emotion_classifier"
        : \`evaluation_id:\${input.sentiment_evaluation_id}\`,
      tenant_id: input.expected_tenant_id,
    };

    if (input.anger_flag === true) {
      context.anger_flag = availableSignal(true, signalSource, ceMeta);
    }
    if (
      typeof input.sentiment_score === "number" &&
      Number.isFinite(input.sentiment_score)
    ) {
      context.sentiment_score = availableSignal(input.sentiment_score, signalSource, ceMeta);
    }
    if (
      sentimentProvenance === "conversation_evaluation" &&
      Array.isArray(input.sentiment_trend) &&
      input.sentiment_trend.length >= 2 &&
      input.sentiment_trend.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      context.sentiment_trend = availableSignal(
        input.sentiment_trend,
        "conversation_evaluation",
        ceMeta,
      );
    }
    if (input.sentiment_recovered_same_turn === true) {
      context.sentiment_recovered_same_turn = availableSignal(
        true,
        signalSource,
        {
          ...ceMeta,
          reason: sentimentProvenance === "current_turn"
            ? "current_turn_emotion_recovery"
            : \`evaluation_id:\${input.sentiment_evaluation_id}:recovery\`,
        },
      );
    }
  }

`;

source = source.slice(0, start) + newBlock + source.slice(end);
fs.writeFileSync(path, source);
console.log("Task 7.2 escalation provenance repair applied");
