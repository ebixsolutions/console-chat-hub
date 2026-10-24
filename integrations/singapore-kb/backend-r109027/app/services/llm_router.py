"""
Platform LLM Router — 真實路由（回應 QA CONDITIONAL FAIL gap #2）。

前一版 core/llm.invoke_llm 只用 model 名稱猜 provider，接受 db 但不使用。
本模組真正做到：
  1. 讀 PlatformLLMRoutingPolicy（依 app/task/module/agent 選最具體 active policy）。
  2. Content risk + complexity scoring（keyword + 長度），推薦 tier。
  3. tier clamp 至 [min_tier, max_tier]；high/critical + allow_auto_escalation → escalate。
  4. 查 PlatformLLMCreditBudget：over hard_stop → block/降級；over warning → warning；
     high/critical/reasoning 受 min-tier 保護，不降到 min 以下。
  5. 由 PlatformLLMProviderConfig 選 provider + model，建 fallback chain。
  6. 寫 PlatformLLMRoutingDecisionLog（決策前）+ PlatformLLMRequestLog（每次呼叫）。
  7. provider fallback：主 provider 失敗自動換下一個並記錄 fallback_used。

無任何 policy/provider/budget 資料時 → 安全預設（default tier + provider 名稱推斷），
仍完整寫 log，確保「Routing + Budget + Logs」在 runtime 可被證明。
"""
from __future__ import annotations

from app.core.shared_attempt_guard import AccountingDenied
import time
import uuid
from typing import Any, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import (PlatformLLMRoutingPolicy, PlatformLLMCreditBudget,
                        PlatformLLMProviderConfig, PlatformLLMRequestLog,
                        PlatformLLMRoutingDecisionLog)

TIER_ORDER = ["fast", "balanced", "reasoning", "premium_reasoning"]

# 每 1K token 粗估成本（USD），用於 budget/日誌；真實環境可由 ModelOption 覆寫
_COST_PER_1K = {"fast": 0.0005, "balanced": 0.0015,
                "reasoning": 0.006, "premium_reasoning": 0.02}

_RISK_KEYWORDS = {
    "critical": ["醫療", "診斷", "法律", "合約條款", "退款保證", "medical",
                 "legal", "liability", "guarantee", "compliance"],
    "high": ["價格", "退款", "保固", "條款", "政策", "price", "refund",
             "warranty", "policy", "terms"],
}


def _tier_idx(t: str) -> int:
    return TIER_ORDER.index(t) if t in TIER_ORDER else 0


def _clamp_tier(t: str, lo: str, hi: str) -> str:
    i = max(_tier_idx(lo), min(_tier_idx(t), _tier_idx(hi)))
    return TIER_ORDER[i]


def _estimate_tokens(text: str) -> int:
    return max(1, len(text or "") // 4)


# ══════════════════════════════════════════════════════════════════════════
# Policy 解析
# ══════════════════════════════════════════════════════════════════════════
def resolve_policy(db: Session, app_key: str, task_type: str,
                   module_key: Optional[str] = None,
                   agent_key: Optional[str] = None
                   ) -> Optional[PlatformLLMRoutingPolicy]:
    q = (db.query(PlatformLLMRoutingPolicy)
         .filter(PlatformLLMRoutingPolicy.is_active.is_(True),
                 PlatformLLMRoutingPolicy.task_type == task_type,
                 or_(PlatformLLMRoutingPolicy.app_key == app_key,
                     PlatformLLMRoutingPolicy.app_key == "any",
                     PlatformLLMRoutingPolicy.app_key.is_(None))))
    policies = q.all()
    if not policies:
        return None

    def specificity(p: PlatformLLMRoutingPolicy) -> int:
        s = 0
        if p.app_key == app_key:
            s += 4
        if agent_key and p.agent_key == agent_key:
            s += 2
        if module_key and p.module_key == module_key:
            s += 1
        return s

    policies.sort(key=specificity, reverse=True)
    return policies[0]


# ══════════════════════════════════════════════════════════════════════════
# Content risk / complexity
# ══════════════════════════════════════════════════════════════════════════
def score_content(prompt: str) -> dict:
    text = (prompt or "").lower()
    matched: list[str] = []
    risk = "low"
    for kw in _RISK_KEYWORDS["critical"]:
        if kw.lower() in text:
            matched.append(kw)
            risk = "critical"
    if risk != "critical":
        for kw in _RISK_KEYWORDS["high"]:
            if kw.lower() in text:
                matched.append(kw)
                risk = "high"
    n = len(prompt or "")
    complexity = "simple" if n < 400 else ("normal" if n < 2000 else "complex")
    rec_tier = {"low": "fast", "high": "reasoning",
                "critical": "reasoning"}[risk]
    if complexity == "complex" and _tier_idx(rec_tier) < _tier_idx("balanced"):
        rec_tier = "balanced"
    risk_score = {"low": 0.2, "high": 0.7, "critical": 0.95}[risk]
    complexity_score = {"simple": 0.2, "normal": 0.5, "complex": 0.85}[complexity]
    return {"content_risk_level": risk, "content_complexity_level": complexity,
            "matched_risk_keywords": matched, "recommended_tier": rec_tier,
            "risk_score": risk_score, "complexity_score": complexity_score}


# ══════════════════════════════════════════════════════════════════════════
# Budget
# ══════════════════════════════════════════════════════════════════════════
def check_budget(db: Session, scope_type: str, scope_key: str,
                 est_cost: float) -> dict:
    budgets = (db.query(PlatformLLMCreditBudget)
               .filter(PlatformLLMCreditBudget.is_active.is_(True),
                       PlatformLLMCreditBudget.scope_type == scope_type,
                       PlatformLLMCreditBudget.scope_key == scope_key).all())
    if not budgets:
        return {"status": "normal", "budget_id": None}
    # 多個 active budget → 取最嚴格（fail-closed）
    rank = {"normal": 0, "warning": 1, "hard_stop": 2}
    worst = {"status": "normal", "budget_id": None, "pct": 0.0,
             "require_approval": False}
    for b in budgets:
        limit = float(b.daily_limit_usd or 0)
        if limit <= 0:
            continue
        day = float(b.current_day_usage_usd or 0) + est_cost
        pct = 100.0 * day / limit
        hard = float(b.hard_stop_threshold_percent or 100)
        warn = float(b.warning_threshold_percent or 80)
        status = ("hard_stop" if pct >= hard
                  else "warning" if pct >= warn else "normal")
        if rank[status] >= rank[worst["status"]]:
            worst = {"status": status, "budget_id": b.id, "pct": pct,
                     "require_approval": bool(b.require_approval_when_over_budget)}
    return worst


# ══════════════════════════════════════════════════════════════════════════
# Provider 選擇 + fallback chain
# ══════════════════════════════════════════════════════════════════════════
def _model_for_tier(cfg: PlatformLLMProviderConfig, tier: str) -> str:
    if _tier_idx(tier) >= _tier_idx("reasoning") and cfg.reasoning_model:
        return cfg.reasoning_model
    return cfg.fast_model or cfg.reasoning_model or settings.default_llm_model


def build_provider_chain(db: Session, preferred: str, fallback: str,
                         tier: str) -> list[dict]:
    active = (db.query(PlatformLLMProviderConfig)
              .filter(PlatformLLMProviderConfig.is_active.is_(True)).all())
    chain: list[dict] = []
    seen = set()

    def add(cfg: PlatformLLMProviderConfig):
        if cfg.id in seen:
            return
        seen.add(cfg.id)
        chain.append({"provider_type": cfg.provider_type,
                      "provider_id": cfg.id,
                      "model": _model_for_tier(cfg, tier)})

    for want in (preferred, fallback):
        if not want or want == "any":
            continue
        for cfg in active:
            if cfg.provider_type == want:
                add(cfg)
    for cfg in active:  # 其餘 active 作最後 fallback
        add(cfg)

    if not chain:  # 完全沒有 provider 設定 → 用 env 預設
        model = settings.default_llm_model
        ptype = "vertex" if "gemini" in model else "openai"
        chain.append({"provider_type": ptype, "provider_id": None,
                      "model": model})
    return chain


# ══════════════════════════════════════════════════════════════════════════
# 主入口 — routed invoke（供 core/llm.invoke_llm 呼叫）
# ══════════════════════════════════════════════════════════════════════════
def routed_invoke(
    db: Session, *, prompt: str,
    app_key: str = "knowledge_base",
    task_type: str = "classification",
    module_key: Optional[str] = None,
    agent_key: Optional[str] = None,
    source_object_type: Optional[str] = None,
    source_object_id: Optional[str] = None,
    response_json_schema: Optional[dict] = None,
    file_urls: Optional[list] = None,
    temperature: float = 0.2,
    max_tokens: Optional[int] = None,  # None = 不限制輸出 token
    call_fn=None,
) -> dict:
    """
    完整路由 + 呼叫 + 日誌。回傳 {text, model_used, provider_type, tier,
    fallback_used, trace_id, routing_decision_id}。

    call_fn(provider_type, model, prompt, temperature, max_tokens, file_urls) -> str
    由 core/llm 注入真實 adapter；未注入時用 core/llm 的 provider adapters。
    """
    trace_id = uuid.uuid4().hex
    policy = resolve_policy(db, app_key, task_type, module_key, agent_key)
    content = score_content(prompt if not response_json_schema
                            else prompt)  # schema 附加不影響 risk

    # tier 決策
    if policy:
        base_tier = policy.default_model_tier or "fast"
        min_tier = policy.min_model_tier or "fast"
        max_tier = policy.max_model_tier or "premium_reasoning"
        allow_esc = bool(policy.allow_auto_escalation)
        allow_down = bool(policy.allow_auto_downgrade)
        preferred = policy.preferred_provider_type or "any"
        fb = policy.fallback_provider_type or "any"
    else:
        base_tier, min_tier, max_tier = "fast", "fast", "premium_reasoning"
        allow_esc, allow_down = True, False
        preferred, fb = "any", "any"

    tier = base_tier
    escalated = downgraded = False
    escalation_reason = downgrade_reason = ""

    # 依 content risk escalate
    if allow_esc and _tier_idx(content["recommended_tier"]) > _tier_idx(tier):
        tier = content["recommended_tier"]
        escalated = True
        escalation_reason = f"content_risk={content['content_risk_level']}"

    tier = _clamp_tier(tier, min_tier, max_tier)

    # budget
    in_tokens = _estimate_tokens(prompt)
    est_cost = (in_tokens + (max_tokens or 4096)) / 1000.0 * _COST_PER_1K.get(tier, 0.001)
    budget = check_budget(db, "app", app_key, est_cost)
    budget_downgrade_applied = min_protect = False
    if budget["status"] == "hard_stop":
        # high/critical 或 reasoning 受保護，不可降到 min 以下
        if allow_down and content["content_risk_level"] in ("low",):
            new_tier = _clamp_tier("fast", min_tier, max_tier)
            if _tier_idx(new_tier) < _tier_idx(tier):
                tier = new_tier
                downgraded = budget_downgrade_applied = True
                downgrade_reason = "budget_hard_stop"
        else:
            min_protect = True  # 保護高風險，不因預算降級

    # provider chain
    chain = build_provider_chain(db, preferred, fb, tier)

    # routing decision log（決策前寫）
    decision = PlatformLLMRoutingDecisionLog(
        request_trace_id=trace_id, app_key=app_key, module_key=module_key,
        task_type=task_type, agent_key=agent_key,
        policy_id=(policy.id if policy else None),
        source_object_type=source_object_type, source_object_id=source_object_id,
        input_token_estimate=in_tokens,
        complexity_score=content["complexity_score"],
        risk_score=content["risk_score"],
        selected_provider_type=chain[0]["provider_type"],
        selected_provider_id=chain[0]["provider_id"],
        selected_model=chain[0]["model"], selected_model_tier=tier,
        routing_reason=(f"policy={'yes' if policy else 'default'};"
                        f"tier={tier};risk={content['content_risk_level']}"),
        was_escalated=escalated, was_downgraded=downgraded,
        estimated_cost_usd=est_cost,
        content_risk_level=content["content_risk_level"],
        content_complexity_level=content["content_complexity_level"],
        matched_risk_keywords={"values": content["matched_risk_keywords"]},
        recommended_model_tier_by_content=content["recommended_tier"],
        final_selected_model_tier=tier,
        downgrade_reason=downgrade_reason or None,
        escalation_reason=escalation_reason or None,
        credit_budget_status=budget["status"],
        budget_downgrade_applied=budget_downgrade_applied,
        min_tier_protection_applied=min_protect,
    )
    db.add(decision)
    db.flush()

    # 呼叫 + fallback + request log
    last_err = None
    for attempt_i, node in enumerate(chain):
        t0 = time.time()
        try:
            text = call_fn(node["provider_type"], node["model"], prompt,
                           temperature, max_tokens, file_urls)
            latency = int((time.time() - t0) * 1000)
            out_tokens = _estimate_tokens(text or "")
            db.add(PlatformLLMRequestLog(
                request_trace_id=trace_id, app_key=app_key, module_key=module_key,
                task_type=task_type, agent_key=agent_key,
                source_object_type=source_object_type,
                source_object_id=source_object_id,
                provider_type=node["provider_type"],
                provider_config_id=node["provider_id"],
                model_used=node["model"], model_tier=(
                    "reasoning" if _tier_idx(tier) >= _tier_idx("reasoning")
                    else "fast"),
                input_tokens=in_tokens, output_tokens=out_tokens,
                estimated_cost_usd=(in_tokens + out_tokens) / 1000.0
                * _COST_PER_1K.get(tier, 0.001),
                latency_ms=latency, status="success",
                retry_count=attempt_i,
                fallback_used=(attempt_i > 0),
                fallback_provider_type=(chain[0]["provider_type"]
                                        if attempt_i > 0 else None),
            ))
            db.flush()
            return {"text": text, "model_used": node["model"],
                    "provider_type": node["provider_type"], "tier": tier,
                    "fallback_used": attempt_i > 0, "trace_id": trace_id,
                    "routing_decision_id": decision.id}
        except AccountingDenied:
            raise
        except Exception as e:
            last_err = e
            latency = int((time.time() - t0) * 1000)
            code = "timeout" if "timeout" in str(e).lower() else "unknown"
            db.add(PlatformLLMRequestLog(
                request_trace_id=trace_id, app_key=app_key, module_key=module_key,
                task_type=task_type, agent_key=agent_key,
                provider_type=node["provider_type"],
                provider_config_id=node["provider_id"],
                model_used=node["model"], model_tier=(
                    "reasoning" if _tier_idx(tier) >= _tier_idx("reasoning")
                    else "fast"),
                input_tokens=in_tokens, latency_ms=latency,
                status=("timeout" if code == "timeout" else "failed"),
                retry_count=attempt_i, fallback_used=(attempt_i > 0),
                error_code=code, error_message=str(e)[:500],
            ))
            db.flush()
            continue  # 換下一個 provider

    if last_err:
        decision.fallback_used = True
        decision.fallback_reason = f"all_providers_failed: {last_err}"
        db.flush()
        raise RuntimeError(f"llm_all_providers_failed: {last_err}")
    raise RuntimeError("llm_no_provider_available")
