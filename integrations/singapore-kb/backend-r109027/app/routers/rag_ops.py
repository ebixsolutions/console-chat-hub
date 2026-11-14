"""
RAG Context Search 端點 — 移植 knowledge-base 的 POST /api/v1/rag/context-search。

body: {query, candidate_top_k=10, max_documents=1,
       max_summary_chunks=1, max_full_content_chunks=3, score_threshold=0.7}
auth: 無需 Authorization；header 需傳 api_key（X-API-Key 或 api_key），
      對應 company 表的 api_key，以此解析 company_id（company 隔離檢索）
回傳：aggregated llm_context + selected_documents + citations + meta，
      或 explicit no-context 契約（fallback: no_qualified_context）。

僅檢索 production 環境已發布向量；staging 永不外洩。
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Header, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import Company
from app.core.c3_accounting import bind_request, reset_request, make_contract
from app.core.shared_attempt_guard import AccountingDenied
from app.services.vector_store import kb_context_search

router = APIRouter(prefix="/api/v1/rag", tags=["rag"])


@router.post("/context-search")
def context_search(
    request: Request,
    body: dict = Body(...),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    api_key_header: str | None = Header(default=None, alias="api_key"),
    db: Session = Depends(get_db),
):
    # ── 1. Authenticate via api_key header → company_id ─────────────────────
    api_key = x_api_key or api_key_header
    if not api_key:
        return JSONResponse(
            status_code=401,
            content={
                "success": False,
                "error": {"code": "unauthorized",
                          "message": "api_key header is required"},
            },
        )

    company = db.query(Company).filter(Company.api_key == api_key).first()
    if company is None:
        return JSONResponse(
            status_code=401,
            content={
                "success": False,
                "error": {"code": "unauthorized", "message": "invalid api_key"},
            },
        )
    company_id = int(company.id)

    # ── 2. Validate required fields ──────────────────────────────────────────
    query = body.get("query")
    if not query or not isinstance(query, str) or not query.strip():
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": {"code": "invalid_request", "message": "query is required"},
            },
        )

    # ── 3. Extract parameters with defaults ──────────────────────────────────
    candidate_top_k = body.get("candidate_top_k", 10)
    if not isinstance(candidate_top_k, int) or candidate_top_k < 1:
        candidate_top_k = 10

    max_documents = body.get("max_documents", 1)
    if not isinstance(max_documents, int) or max_documents < 1:
        max_documents = 1

    max_summary_chunks = body.get("max_summary_chunks", 1)
    if not isinstance(max_summary_chunks, int) or max_summary_chunks < 0:
        max_summary_chunks = 1

    max_full_content_chunks = body.get("max_full_content_chunks", 3)
    if not isinstance(max_full_content_chunks, int) or max_full_content_chunks < 0:
        max_full_content_chunks = 3

    score_threshold = body.get("score_threshold", 0.7)
    if not isinstance(score_threshold, (int, float)):
        score_threshold = 0.7

    # ── 4. Delegate to knowledge-base 移植邏輯 ───────────────────────────────
    token = None
    try:
        token = bind_request(request, company, api_key, body)
        result = kb_context_search(
            db, query, company_id=company_id,
            candidate_top_k=candidate_top_k,
            max_documents=max_documents,
            max_summary_chunks=max_summary_chunks,
            max_full_content_chunks=max_full_content_chunks,
            score_threshold=score_threshold,
        )
    except AccountingDenied:
        return JSONResponse(status_code=403, content={"success": False, "error": {"code": "model_accounting_denied"}}, headers={"Cache-Control": "no-store"})
    except Exception:
        # 與 knowledge-base 一致：query embedding 失敗 → 500
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": {"code": "internal_error",
                          "message": "Failed to generate embedding for query"},
            },
        )

    finally:
        reset_request(token)

    return JSONResponse(content=result, headers={"Cache-Control": "no-store"})


@router.get("/context-search/model-accounting-contract")
def model_accounting_contract(request: Request, db: Session = Depends(get_db)):
    try:
        return make_contract(request, db)
    except AccountingDenied:
        return JSONResponse(status_code=403, content={"error": "model_accounting_denied"}, headers={"Cache-Control": "no-store"})
