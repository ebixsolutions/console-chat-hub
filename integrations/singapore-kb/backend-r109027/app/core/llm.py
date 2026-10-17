"""
LLM 適配層 — 取代 Base44 的 base44.integrations.Core.InvokeLLM

支援：Vertex Gemini（主）/ OpenAI / DeepSeek
路由：依 PlatformLLMRoutingPolicy，記 PlatformLLMRequestLog + RoutingDecisionLog，
      檢查 PlatformLLMCreditBudget。

Singapore 獨立運行：Vertex 用 SA JSON 換 access token（後端可行，
不像 Base44 前端 JWT 受限）。
"""
from __future__ import annotations
import json
import re
import time
from typing import Any, Optional

import requests
from app.core.c3_accounting import provider_post
from app.core.shared_attempt_guard import AccountingDenied

from app.core.config import settings

LLM_RETRY = 3
LLM_BACKOFF_S = 1.5


# ══════════════════════════════════════════════════════════════════════════
# Vertex access token（SA JSON → OAuth）
# ══════════════════════════════════════════════════════════════════════════
_vertex_token_cache: dict = {"token": None, "exp": 0}


def _vertex_access_token() -> str:
    now = time.time()
    if _vertex_token_cache["token"] and now < _vertex_token_cache["exp"] - 60:
        return _vertex_token_cache["token"]
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request as GARequest
        creds = service_account.Credentials.from_service_account_file(
            settings.vertex_sa_json,
            scopes=["https://www.googleapis.com/auth/cloud-platform"],
        )
        creds.refresh(GARequest())
        _vertex_token_cache["token"] = creds.token
        _vertex_token_cache["exp"] = now + 3000
        return creds.token
    except Exception as e:
        raise RuntimeError(f"vertex_token_failed: {e}")


# ══════════════════════════════════════════════════════════════════════════
# Credit usage reporting（每次 Vertex 呼叫後回報 token 用量給外部平台計費）
# ══════════════════════════════════════════════════════════════════════════
def _estimate_tokens(text: str) -> int:
    return max(1, len(text or "") // 4)


def _vertex_usage_tokens(data: dict, prompt: str, text: str) -> int:
    """從 Vertex 回應 usageMetadata 取 token 數；缺欄位時以 prompt/text 長度粗估。"""
    usage = data.get("usageMetadata") or {}
    total = usage.get("totalTokenCount")
    if total is None:
        total = ((usage.get("promptTokenCount") or 0)
                 + (usage.get("candidatesTokenCount") or 0))
    if not total:
        total = _estimate_tokens(prompt) + _estimate_tokens(text)
    return int(total or 0)


def _report_vertex_usage(data: dict, model: str, prompt: str, text: str) -> None:
    """best-effort 回報；無 user context（背景任務）時自動跳過。"""
    try:
        from app.core.credit import report_credit_usage
        from app.core.tenant_ctx import get_company, get_user
        report_credit_usage(
            get_user(), get_company(),
            usage=_vertex_usage_tokens(data, prompt, text),
            description=f"Vertex AI调用消耗({model})",
        )
    except Exception:
        pass  # 計費回報絕不影響主流程


# ══════════════════════════════════════════════════════════════════════════
# Adapters
# ══════════════════════════════════════════════════════════════════════════
def _vertex_generate(prompt: str, model: str, temperature: float,
                     max_tokens: int, file_urls: Optional[list]) -> str:
    token = _vertex_access_token()
    region = settings.vertex_location
    project = settings.vertex_project
    endpoint = (f"https://{region}-aiplatform.googleapis.com/v1/projects/"
                f"{project}/locations/{region}/publishers/google/models/"
                f"{model}:generateContent")
    parts: list[dict] = [{"text": prompt}]
    for u in (file_urls or []):
        parts.append({"file_data": {"file_uri": u, "mime_type": "application/pdf"}})
    # Vertex 輸出 token 預設不限制（由模型原生上限決定）；僅明確指定 max_tokens 才設上限
    gen_config: dict = {"temperature": temperature}
    if max_tokens:
        gen_config["maxOutputTokens"] = max_tokens
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": gen_config,
    }
    r = provider_post(endpoint, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }, json=body, timeout=120)
    if r.status_code == 404:
        raise RuntimeError("model_not_found")
    if r.status_code == 429:
        raise RuntimeError("rate_limited")
    if r.status_code >= 400:
        # 透出 Google 真實訊息，避免只剩泛化的 HTTP reason。
        # 403 常見原因：Vertex AI API 未啟用 / SA 缺 roles/aiplatform.user /
        # 模型未 allowlist / billing 未連結（錯誤體會寫明是哪一種）。
        reason = r.reason or "http_error"
        try:
            err = (r.json() or {}).get("error") or {}
            reason = err.get("message") or err.get("status") or reason
        except Exception:  # noqa: BLE001 — body 非 JSON
            reason = (r.text or reason)[:500]
        raise RuntimeError(f"vertex_http_{r.status_code}: {reason}")
    data = r.json()
    cands = data.get("candidates", [])
    text = ""
    if cands:
        text = "".join(p.get("text", "")
                       for p in cands[0].get("content", {}).get("parts", []))
    _report_vertex_usage(data, model, prompt, text)
    return text


def _openai_generate(prompt: str, model: str, temperature: float,
                     max_tokens: Optional[int], ) -> str:
    payload: dict = {
        "model": model, "temperature": temperature,
        "messages": [{"role": "user", "content": prompt}],
    }
    if max_tokens:  # 未指定時不限制（用模型原生上限）
        payload["max_tokens"] = max_tokens
    r = provider_post(f"{settings.openai_base_url}/chat/completions", headers={
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }, json=payload, timeout=120)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _deepseek_generate(prompt: str, model: str, temperature: float,
                       max_tokens: Optional[int]) -> str:
    payload: dict = {
        "model": model, "temperature": temperature,
        "messages": [{"role": "user", "content": prompt}],
    }
    if max_tokens:  # 未指定時不限制（用模型原生上限）
        payload["max_tokens"] = max_tokens
    r = provider_post(f"{settings.deepseek_base_url}/chat/completions", headers={
        "Authorization": f"Bearer {settings.deepseek_api_key}",
        "Content-Type": "application/json",
    }, json=payload, timeout=120)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


# ══════════════════════════════════════════════════════════════════════════
# 統一入口
# ══════════════════════════════════════════════════════════════════════════
def _strip_fences(txt: str) -> str:
    """移除 LLM 常加的 ```json / ``` 圍欄及其所在行（含前後多餘內容）。"""
    clean = (txt or "").strip()
    m = re.search(r"^```[^\n]*\n?", clean, re.MULTILINE)
    if m and m.start() == 0:
        clean = clean[m.end():]
        end = clean.rfind("```")
        if end != -1:
            line_start = clean.rfind("\n", 0, end)
            clean = clean[:line_start if line_start != -1 else 0]
    return clean.strip()


def _repair_missing_commas(txt: str) -> str:
    """修復 LLM 常見缺逗號：value 結束（" } ] 數字 true/false/null）後
    直接換行接 "key" 時補上逗號。合法 JSON 中不會出現此模式，故無誤傷。"""
    return re.sub(r'(?<=["}\d\]el])(\s*\n\s*)(?=")', r',\1', txt)


def _balance_truncated_json(txt: str) -> str:
    """修復截斷/格式錯誤 JSON：補齊未閉合字串的引號、未閉合的 {} []，
    並把字串內多餘的換行/Tab 控制字元轉成跳脫序列。"""
    s = txt.rstrip()
    if s.count('"') % 2 == 1:
        s += '"'
    out: list[str] = []
    stack: list[str] = []
    in_str = False
    esc = False
    for ch in s:
        if in_str:
            if esc:
                esc = False
                out.append(ch)
            elif ch == "\\":
                esc = True
                out.append(ch)
            elif ch == '"':
                in_str = False
                out.append(ch)
            elif ch == "\n":
                out.append("\\n")
            elif ch == "\r":
                out.append("\\r")
            elif ch == "\t":
                out.append("\\t")
            else:
                out.append(ch)
        elif ch == '"':
            in_str = True
            out.append(ch)
        elif ch in "{[":
            stack.append(ch)
            out.append(ch)
        elif ch in "}]":
            if stack and ((stack[-1] == "{" and ch == "}")
                          or (stack[-1] == "[" and ch == "]")):
                stack.pop()
            out.append(ch)
        else:
            out.append(ch)
    for op in reversed(stack):
        out.append("}" if op == "{" else "]")
    return "".join(out)


def _parse_json(txt: str) -> Any:
    clean = _strip_fences(txt)
    first_err: Optional[json.JSONDecodeError] = None
    try:
        return json.loads(clean)
    except json.JSONDecodeError as e:
        first_err = e

    # LLM 常在前後多加贅字，從第一個 { 開始擷取；沒有 }（截斷）則用整段。
    # 仍失敗則依序嘗試修復缺逗號、截斷，修不動才原樣拋出。
    start = clean.find("{")
    if start == -1:
        raise first_err
    end = clean.rfind("}")
    candidate = clean[start:] if end == -1 else clean[start:end + 1]
    for fixed in (candidate,
                  _repair_missing_commas(candidate),
                  _balance_truncated_json(_repair_missing_commas(candidate))):
        try:
            return json.loads(fixed)
        except json.JSONDecodeError:
            continue
    raise first_err


def invoke_llm(
    prompt: str,
    *,
    response_json_schema: Optional[dict] = None,
    file_urls: Optional[list] = None,
    model: Optional[str] = None,
    temperature: float = 0.2,
    max_tokens: Optional[int] = None,  # None = 不限制輸出 token
    provider: Optional[str] = None,
    db=None,
    **kwargs,
) -> Any:
    """
    取代 base44.integrations.Core.InvokeLLM。

    有 response_json_schema → 回 dict（已解析）
    無 → 回 str
    """
    model = model or settings.default_llm_model

    if response_json_schema:
        prompt = (prompt + "\n\nReturn ONLY valid JSON matching this schema, "
                  "no markdown, no preamble:\n"
                  + json.dumps(response_json_schema, ensure_ascii=False))

    # ── 有 db → 走真實 Platform LLM Router（policy/budget/logs/fallback）──
    if db is not None:
        from app.services.llm_router import routed_invoke

        def _call(ptype, mdl, pr, temp, maxt, furls):
            if ptype in ("vertex", "vertex_ai_gemini", "gemini"):
                return _vertex_generate(pr, mdl, temp, maxt, furls)
            if ptype == "deepseek":
                return _deepseek_generate(pr, mdl, temp, maxt)
            return _openai_generate(pr, mdl, temp, maxt)

        last_err = None
        for attempt in range(1, LLM_RETRY + 1):
            try:
                res = routed_invoke(
                    db, prompt=prompt,
                    app_key=kwargs.get("app_key", "knowledge_base"),
                    task_type=kwargs.get("task_type", "classification"),
                    module_key=kwargs.get("module_key"),
                    agent_key=kwargs.get("agent_key"),
                    source_object_type=kwargs.get("source_object_type"),
                    source_object_id=kwargs.get("source_object_id"),
                    response_json_schema=response_json_schema,
                    file_urls=file_urls,
                    temperature=temperature, max_tokens=max_tokens,
                    call_fn=_call)
                txt = res["text"]
                if response_json_schema:
                    return _parse_json(txt)
                return txt
            except json.JSONDecodeError as e:
                # LLM 偶爾回傳截斷/格式錯誤的 JSON → 重試（含回應片段方便除錯）
                last_err = e
                if attempt < LLM_RETRY:
                    time.sleep(LLM_BACKOFF_S * attempt)
                    continue
                raise RuntimeError(
                    f"llm_json_parse_failed: {e} "
                    f"(response[:300]={txt[:300]!r})") from e
            except AccountingDenied:
                raise
            except RuntimeError as e:
                # 暫時性錯誤（rate limit / timeout / 429）→ backoff 重試整條 provider chain；
                # 與上方無 db 路徑行為一致，避免全部 provider 被限流時立即 500
                last_err = e
                msg = str(e).lower()
                if ("timeout" in msg or "rate_limited" in msg or "429" in msg) \
                        and attempt < LLM_RETRY:
                    time.sleep(LLM_BACKOFF_S * attempt)
                    continue
                raise
            except Exception:
                raise  # 其他 provider 層錯誤（含 fallback 全失敗）原樣拋出

    # ── 無 db → 直接 adapter（低階呼叫，仍保留 retry）──
    provider = provider or ("vertex" if "gemini" in model else "openai")
    last_err = None
    for attempt in range(1, LLM_RETRY + 1):
        try:
            if provider == "vertex":
                txt = _vertex_generate(prompt, model, temperature, max_tokens, file_urls)
            elif provider == "deepseek":
                txt = _deepseek_generate(prompt, model, temperature, max_tokens)
            else:
                txt = _openai_generate(prompt, model, temperature, max_tokens)

            if response_json_schema:
                return _parse_json(txt)
            return txt
        except AccountingDenied:
            raise
        except Exception as e:
            last_err = e
            msg = str(e).lower()
            if "timeout" in msg or "rate_limited" in msg or "429" in msg:
                if attempt < LLM_RETRY:
                    time.sleep(LLM_BACKOFF_S * attempt)
                    continue
            if attempt < LLM_RETRY and response_json_schema:
                time.sleep(LLM_BACKOFF_S * attempt)
                continue
            break
    raise RuntimeError(f"llm_invoke_failed: {last_err}")


# ══════════════════════════════════════════════════════════════════════════
# Embedding
# ══════════════════════════════════════════════════════════════════════════
def generate_embedding(text: str, model: Optional[str] = None) -> list[float]:
    """Vertex embedding（gemini-embedding-001，多語言）。

    gemini-embedding-001 預設 3072 維，透過 outputDimensionality 固定為
    settings.embedding_dims（768），與 kb_vector_chunk.embedding_vector 一致。
    """
    model = model or settings.embedding_model
    token = _vertex_access_token()
    region = settings.vertex_location
    project = settings.vertex_project
    endpoint = (f"https://{region}-aiplatform.googleapis.com/v1/projects/"
                f"{project}/locations/{region}/publishers/google/models/"
                f"{model}:predict")
    body = {
        "instances": [{"content": text}],
        "parameters": {"outputDimensionality": settings.embedding_dims},
    }
    r = provider_post(endpoint, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }, json=body, timeout=60)
    r.raise_for_status()
    preds = r.json().get("predictions", [])
    if not preds:
        return []
    try:
        from app.core.credit import report_credit_usage
        from app.core.tenant_ctx import get_company, get_user
        report_credit_usage(
            get_user(), get_company(),
            usage=_estimate_tokens(text),
            description=f"Vertex AI Embedding调用消耗({model})",
        )
    except Exception:
        pass  # 計費回報絕不影響主流程
    return preds[0].get("embeddings", {}).get("values", [])
