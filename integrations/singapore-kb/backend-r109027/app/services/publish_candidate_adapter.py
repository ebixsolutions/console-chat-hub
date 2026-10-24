"""
Base44 2026-08-24 Candidate/Staging/Production adapter for FastAPI.

Ports the post-FastAPI Base44 invariants:
- candidate versions remain off-live until atomic activation
- Staging and Production vectors must be real embeddings
- current Live document/vector set remains untouched during candidate preparation
- activation switches content/version/hash/RAG/pointer together
- rollback restores the exact previous document and vector visibility
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models import KBDocument, KBDocumentVersion, KBVectorChunk
from app.services.kb_services import chunk_content
from app.services.vector_store import embed_text


def now():
    return datetime.now(timezone.utc)


def canonical_content_hash(text: str) -> str:
    return hashlib.sha256((text or "").strip().encode("utf-8")).hexdigest()


def vector_values(row: KBVectorChunk) -> list:
    value = getattr(row, "embedding_vector", None)
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return value.get("values") or value.get("value") or []
    return []


def is_real_embedding(row: KBVectorChunk) -> bool:
    vals = vector_values(row)
    return (
        getattr(row, "embedding_status", None) == "generated"
        and getattr(row, "embedding_model", None) != "placeholder"
        and getattr(row, "vector_store", None) != "base44_placeholder"
        and (bool(vals) or bool(getattr(row, "external_vector_id", None)))
    )


def operation_binding(op, document_id: str) -> dict:
    summary = getattr(op, "detection_summary", None) or {}
    bindings = summary.get("document_bindings") or []
    if isinstance(bindings, dict):
        bindings = bindings.get("items") or []
    for b in bindings:
        if isinstance(b, dict) and b.get("document_id") == document_id:
            return b
    return {}


def load_bound_candidate_version(
    db: Session, doc: KBDocument, version_id: str, binding: Optional[dict] = None
) -> tuple[KBDocumentVersion, str, str]:
    version = db.query(KBDocumentVersion).filter(KBDocumentVersion.id == version_id).first()
    if not version or version.document_id != doc.id:
        raise RuntimeError("CANDIDATE_NOT_FOUND")
    content = (version.raw_content_snapshot or "").strip()
    if not content:
        raise RuntimeError("CANDIDATE_EMPTY_CONTENT")
    candidate_hash = canonical_content_hash(content)
    binding = binding or {}
    if binding.get("candidate_version_id") and binding["candidate_version_id"] != version.id:
        raise RuntimeError("CANDIDATE_BINDING_MISMATCH")
    if binding.get("candidate_version") and binding["candidate_version"] != version.version:
        raise RuntimeError("CANDIDATE_VERSION_OR_HASH_DRIFT")
    if binding.get("candidate_content_hash") and binding["candidate_content_hash"] != candidate_hash:
        raise RuntimeError("CANDIDATE_VERSION_OR_HASH_DRIFT")
    return version, candidate_hash, content


def _supersede_rows(rows):
    for row in rows:
        row.status = "superseded"


def _embed_chunk(db: Session, *, doc: KBDocument, version_id: str, index: int,
                 text: str, chunk_type: str, environment: str) -> KBVectorChunk:
    vec, model, store = embed_text(text)
    if not vec:
        raise RuntimeError("REAL_EMBEDDING_VERIFICATION_FAILED")
    row = KBVectorChunk(
        document_id=doc.id,
        version_id=version_id,
        chunk_index=index,
        chunk_text=text,
        chunk_type=chunk_type,
        token_count=max(1, len(text) // 4),
        embedding_status="generated",
        embedding_model=model,
        embedding_vector={"values": vec},
        embedding_dimensions=len(vec),
        embedded_at=now(),
        vector_store=store,
        environment=environment,
        status="active",
        created_by=getattr(doc, "created_by", None),
        tenant_id=getattr(doc, "tenant_id", None),
        company_id=getattr(doc, "company_id", None),
    )
    db.add(row)
    db.flush()
    return row


def _rag_summary_text(content: str) -> str:
    # Deterministic, source-grounded fallback. The live Base44 implementation
    # uses LLM generation; FastAPI may replace this with its configured LLM,
    # but must never invent facts. This produces a compact extractive summary.
    paragraphs = [p.strip() for p in (content or "").split("\n") if p.strip()]
    text = " ".join(paragraphs[:6]).strip()
    return text[:1800] if text else (content or "")[:1800]


def ensure_candidate_staging(
    db: Session, doc: KBDocument, version: KBDocumentVersion, *, mutate_doc: bool
) -> dict:
    content = (version.raw_content_snapshot or "").strip()
    if not content:
        raise RuntimeError("EMPTY_ACTIVE_VERSION_CONTENT")

    old = (
        db.query(KBVectorChunk)
        .filter(
            KBVectorChunk.document_id == doc.id,
            KBVectorChunk.version_id == version.id,
            KBVectorChunk.environment == "staging",
            KBVectorChunk.status == "active",
        )
        .all()
    )
    _supersede_rows(old)

    chunks = chunk_content(content, source_type=doc.source_type or "")
    if not chunks:
        raise RuntimeError("STAGING_NOT_READY")

    rows = []
    for i, ch in enumerate(chunks):
        rows.append(_embed_chunk(
            db, doc=doc, version_id=version.id, index=i,
            text=ch["text"], chunk_type=ch.get("type") or "full_content",
            environment="staging",
        ))

    summary = _rag_summary_text(content)
    if summary:
        rows.append(_embed_chunk(
            db, doc=doc, version_id=version.id, index=len(rows),
            text=summary, chunk_type="rag_summary", environment="staging",
        ))

    if not rows or any(not is_real_embedding(r) for r in rows):
        raise RuntimeError("REAL_EMBEDDING_VERIFICATION_FAILED")
    if not any(r.chunk_type != "rag_summary" for r in rows):
        raise RuntimeError("NO_STAGING_CONTENT_CHUNKS")

    version.content_hash = canonical_content_hash(content)
    version.rag_summary = summary
    version.rag_summary_hash = canonical_content_hash(summary) if summary else ""
    version.vector_status = "generated"
    db.add(version)

    if mutate_doc:
        doc.staging_vector_status = "indexed"
        doc.content_hash = version.content_hash
        doc.rag_summary = summary
        doc.rag_summary_hash = version.rag_summary_hash
        doc.chunk_count = len(rows)
        doc.vector_count = len(rows)
        db.add(doc)

    db.commit()
    return {"rows": rows, "summary": summary, "content_hash": version.content_hash}


def verified_vector_set(
    db: Session, document_id: str, version_id: str, environment: str
) -> list[KBVectorChunk]:
    rows = (
        db.query(KBVectorChunk)
        .filter(
            KBVectorChunk.document_id == document_id,
            KBVectorChunk.version_id == version_id,
            KBVectorChunk.environment == environment,
            KBVectorChunk.status == "active",
        )
        .all()
    )
    if not rows or any(not is_real_embedding(r) for r in rows):
        return []
    if not any(r.chunk_type != "rag_summary" for r in rows):
        return []
    return rows


def copy_staging_to_candidate_production(
    db: Session, doc: KBDocument, version_id: str
) -> list[KBVectorChunk]:
    existing = verified_vector_set(db, doc.id, version_id, "production")
    if existing:
        return existing
    staging = verified_vector_set(db, doc.id, version_id, "staging")
    if not staging:
        raise RuntimeError("STAGING_NOT_READY")

    created = []
    for r in staging:
        row = KBVectorChunk(
            document_id=r.document_id,
            version_id=r.version_id,
            chunk_index=r.chunk_index,
            chunk_text=r.chunk_text,
            chunk_type=r.chunk_type,
            token_count=r.token_count,
            embedding_status=r.embedding_status,
            embedding_model=r.embedding_model,
            embedding_vector=r.embedding_vector,
            embedding_dimensions=r.embedding_dimensions,
            embedded_at=r.embedded_at or now(),
            vector_store=r.vector_store,
            external_vector_id=r.external_vector_id,
            environment="production",
            status="active",
            created_by=getattr(doc, "created_by", None),
            tenant_id=getattr(doc, "tenant_id", None),
            company_id=getattr(doc, "company_id", None),
        )
        db.add(row)
        created.append(row)
    db.commit()

    verified = verified_vector_set(db, doc.id, version_id, "production")
    if len(verified) != len(staging):
        for r in created:
            r.status = "failed"
        db.commit()
        raise RuntimeError("PRODUCTION_COPY_VERIFICATION_FAILED")
    return verified


def activate_candidate(
    db: Session, doc: KBDocument, version: KBDocumentVersion,
    binding: Optional[dict] = None
) -> list[KBVectorChunk]:
    version, candidate_hash, content = load_bound_candidate_version(
        db, doc, version.id, binding
    )
    production = verified_vector_set(db, doc.id, version.id, "production")
    if not production:
        production = copy_staging_to_candidate_production(db, doc, version.id)
    summary_row = next((r for r in production if r.chunk_type == "rag_summary"), None)
    summary = summary_row.chunk_text if summary_row else (version.rag_summary or "")
    summary_hash = canonical_content_hash(summary) if summary else ""

    # Atomic logical switch in one DB transaction: document content/version/pointer
    # and candidate visibility change together.
    doc.raw_content = content
    doc.content_hash = candidate_hash
    doc.version = version.version
    doc.status = "published"
    doc.available_to_live_console = True
    doc.production_vector_status = "indexed"
    doc.production_status = "production"
    doc.active_version_id = version.id
    doc.published_at = now()
    doc.staging_vector_status = "indexed"
    doc.chunk_count = len(production)
    doc.vector_count = len(production)
    doc.rag_summary = summary
    doc.rag_summary_hash = summary_hash
    version.review_status = "approved"
    version.vector_status = "generated"
    version.rag_summary = summary
    version.rag_summary_hash = summary_hash

    old_active = (
        db.query(KBVectorChunk)
        .filter(
            KBVectorChunk.document_id == doc.id,
            KBVectorChunk.environment == "production",
            KBVectorChunk.status == "active",
        )
        .all()
    )
    for row in old_active:
        if row.version_id != version.id:
            row.status = "superseded"

    db.add(doc)
    db.add(version)
    db.commit()
    db.refresh(doc)

    if (
        doc.active_version_id != version.id
        or doc.version != version.version
        or canonical_content_hash(doc.raw_content or "") != candidate_hash
        or doc.status != "published"
        or doc.available_to_live_console is not True
        or doc.production_vector_status != "indexed"
        or doc.production_status != "production"
    ):
        raise RuntimeError("ACTIVATION_VERIFY_FAILED")
    return production


def restore_previous(
    db: Session, doc: KBDocument, prev: dict, candidate_version_id: Optional[str]
) -> bool:
    prev = prev or {}
    target_vid = prev.get("version_id")
    target_content = prev.get("raw_content", doc.raw_content or "")
    target_hash = prev.get("content_hash") or canonical_content_hash(target_content)

    production = (
        db.query(KBVectorChunk)
        .filter(
            KBVectorChunk.document_id == doc.id,
            KBVectorChunk.environment == "production",
        )
        .all()
    )
    for row in production:
        if target_vid and row.version_id == target_vid:
            row.status = "active"
        elif candidate_version_id and candidate_version_id != target_vid and row.version_id == candidate_version_id:
            row.status = "superseded"

    doc.raw_content = target_content
    doc.content_hash = target_hash
    doc.version = prev.get("version") or doc.version or "1.0"
    doc.rag_summary = prev.get("rag_summary") or ""
    doc.rag_summary_hash = prev.get("rag_summary_hash") or ""
    doc.chunk_count = int(prev.get("chunk_count") or 0)
    doc.vector_count = int(prev.get("vector_count") or 0)
    doc.published_at = prev.get("published_at")
    doc.status = prev.get("status") or "approved"
    doc.available_to_live_console = prev.get("available_to_live_console") is True
    doc.production_vector_status = prev.get("production_vector_status") or "not_indexed"
    doc.production_status = prev.get("production_status") or "not_published"
    doc.staging_vector_status = prev.get("staging_vector_status") or "not_indexed"
    doc.active_version_id = target_vid

    if candidate_version_id and candidate_version_id != target_vid:
        candidate = (
            db.query(KBDocumentVersion)
            .filter(KBDocumentVersion.id == candidate_version_id)
            .first()
        )
        if candidate:
            candidate.review_status = "rejected"
            candidate.vector_status = "outdated"
            db.add(candidate)

    db.add(doc)
    db.commit()
    return True
