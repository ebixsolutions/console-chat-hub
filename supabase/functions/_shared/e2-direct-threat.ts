export function isDirectViolentThreat(text: string): boolean {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return false;

  const zhTarget = "(?:你|你們|你们|他|她|他們|他们|她們|她们|某人|人)";
  const zhVerb = "(?:殺|杀|打死|弄死|刺死|傷害|伤害|攻擊|攻击)";
  const zhAspect = "(?:了|掉)?";
  const zhDirect = new RegExp(`(?:我要|我會|我会|我將|我将|我想要|我想|我要去|我準備|我准备)\\s*${zhVerb}${zhAspect}\\s*${zhTarget}`);
  const zhImperative = new RegExp(`${zhVerb}${zhAspect}\\s*${zhTarget}`);
  const enDirect = /\b(?:i\s+(?:will|am going to|want to|plan to)|i['’](?:ll|m\s+going\s+to))\s+(?:kill|hurt|attack|shoot|stab)\s+(?:you|him|her|them|someone|people)\b/i;

  return zhDirect.test(normalized) || zhImperative.test(normalized) || enDirect.test(normalized);
}
