#!/usr/bin/env python3
"""Run ONLY in the existing, authorized KB operator environment.

Read-only DB metadata/content hashing and existing-credential HMAC; no HTTP,
embedding, generation, schema/data update, index or publication operation.
The deployment receipt MUST come from the real existing deployment control
plane. This script checks its local file bindings, NOT its independent
authenticity; Director reviews that receipt before approving any grant.
Never install output automatically. No credential is printed or exported.
"""
import argparse
import ast
import hashlib
import hmac
import json
import pathlib
import time

SCOPE = dict(actor="3bdf936e-b543-41d8-9fff-fa020a85f3f6",
             company="3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
             channel="b0000000-0000-0000-0000-000000000001", tenant="34",
             endpoint="https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search")
FILES = ["app/routers/rag_ops.py", "app/services/vector_store.py", "app/core/llm.py"]
digest = lambda data: hashlib.sha256(data).hexdigest()


def attest(root, receipt_path, document_ids, seconds, out):
    assert 1 <= seconds <= 3600 and 1 <= len(set(document_ids)) == len(document_ids) <= 10
    receipt_bytes = receipt_path.read_bytes()
    receipt = json.loads(receipt_bytes)
    now = int(time.time())
    assert receipt["endpoint"] == SCOPE["endpoint"] and str(receipt["tenant_id"]) == SCOPE["tenant"]
    assert isinstance(receipt["runtime_sha256"], str) and len(receipt["runtime_sha256"]) == 64
    assert all(c in "0123456789abcdef" for c in receipt["runtime_sha256"]) and set(receipt["runtime_sha256"]) != {"0"}
    assert now-300 <= receipt["observed_at"] <= now
    assert receipt["pinned_until"] >= now+seconds and receipt["lineage_pinned_until"] >= now+seconds
    # Compare to an actual deployment's file manifest; a ZIP name/hash is not
    # accepted as the runtime digest. Do not read .env/key/credential files.
    for relative in FILES:
        assert digest((root/relative).read_bytes()) == receipt["files_sha256"][relative]
    module = ast.parse((root/"app/core/llm.py").read_text())
    fn = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == "generate_embedding")
    assert not any(isinstance(n, (ast.For, ast.While, ast.AsyncFor)) for n in ast.walk(fn))
    calls = [n for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
             and isinstance(n.func.value, ast.Name) and n.func.value.id == "requests" and n.func.attr == "post"]
    assert len(calls) == 1, "Existing query embedding must have one provider POST and no loop/retry"
    assert any(k.arg == "timeout" and isinstance(k.value, ast.Constant) and k.value.value == 60 for k in calls[0].keywords)

    # Imports use existing app/server bindings. No new server credentials.
    from sqlalchemy import text
    from app.core.database import SessionLocal
    from app.core.config import settings
    from app.models import Company, KBDocument, KBVectorChunk
    assert settings.require_production_embedding is True
    assert settings.vertex_sa_json and settings.vertex_project and settings.vertex_location and settings.embedding_model
    embedding_config = dict(model=settings.embedding_model, project=settings.vertex_project,
                            location=settings.vertex_location, dimensions=settings.embedding_dims,
                            require_production_embedding=settings.require_production_embedding)
    embedding_config_sha = digest(json.dumps(embedding_config, sort_keys=True, separators=(",", ":")).encode())
    assert receipt["embedding_config_sha256"] == embedding_config_sha
    db = SessionLocal()
    try:
        db.execute(text("SET TRANSACTION READ ONLY"))
        company = db.query(Company).filter(Company.id == 34).one()
        assert isinstance(company.api_key, str) and company.api_key
        rows = db.query(KBDocument.id, KBDocument.active_version_id, KBVectorChunk.id, KBVectorChunk.chunk_type,
                        KBVectorChunk.chunk_text).join(KBVectorChunk, KBVectorChunk.document_id == KBDocument.id).filter(
            KBDocument.id.in_(document_ids), KBDocument.status == "published",
            KBDocument.available_to_live_console.is_(True), KBDocument.production_vector_status == "indexed",
            KBVectorChunk.company_id == 34, KBVectorChunk.environment == "production",
            KBVectorChunk.status == "active", KBVectorChunk.version_id == KBDocument.active_version_id,
            KBVectorChunk.embedding_status.in_(["completed", "generated"]),
            KBVectorChunk.embedding_vector.isnot(None)).all()
        docs = {}
        for doc, version, chunk, chunk_type, content in rows:
            assert version and chunk and content
            assert chunk_type in ["rag_summary", "full_content", "faq_pair", "section"], "Unsupported chunk type; do not relabel evidence"
            entry = docs.setdefault(str(doc), dict(document_id=str(doc), version_id=str(version), chunks=[]))
            entry["chunks"].append(dict(chunk_id=str(chunk), chunk_type=chunk_type, content_sha256=digest(" ".join(content.strip().split()).encode())))
        assert set(docs) == set(document_ids), "Every requested document needs current published/indexed lineage"
        documents = sorted(docs.values(), key=lambda d: d["document_id"])
        for d in documents:
            assert 1 <= len(d["chunks"]) <= 40, "Do not truncate lineage to pass a bound"
            d["chunks"].sort(key=lambda c: c["chunk_id"])
        lineage_bytes = json.dumps(documents, sort_keys=True, separators=(",", ":")).encode()
        payload = dict(SCOPE, protocol="original-preview-query-embedding-v1", runtime_sha256=receipt["runtime_sha256"],
                       deployment_evidence_sha256=digest(receipt_bytes), embedding_config_sha256=embedding_config_sha, lineage_evidence_sha256=digest(lineage_bytes),
                       observed_at=now, expires=now+seconds, deployment_pinned_until_expiry=True,
                       lineage_pinned_until_expiry=True, query_embedding_calls=1, embedding_retries=0,
                       generation_calls=0, ingestion_allowed=False, reindex_allowed=False, max_query_bytes=2048,
                       documents=documents)
        encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        assert len(encoded.encode()) <= 32768, "Do not truncate evidence"
        signature = hmac.new(company.api_key.encode(), encoded.encode(), hashlib.sha256).hexdigest()
        binding = dict(actor_id=SCOPE["actor"], company_id=SCOPE["company"], channel_id=SCOPE["channel"],
                       tenant_id=SCOPE["tenant"], endpoint=SCOPE["endpoint"], provider="singapore-kb", purpose="kb_embedding",
                       remote_mode="query_embedding_attested_v1", allow_remote_embedding=True,
                       remote_runtime_sha256=receipt["runtime_sha256"], deployment_evidence_sha256=digest(receipt_bytes),
                       embedding_config_sha256=embedding_config_sha,
                       lineage_evidence_sha256=digest(lineage_bytes), attestation_payload=encoded, attestation_signature=signature)
    finally:
        db.rollback()
        db.close()
    out.mkdir(parents=True, exist_ok=True)
    (out/"Lineage-Metadata.json").write_bytes(lineage_bytes)
    (out/"PROPOSED-NOT-INSTALLED-KB-Grant.json").write_text(json.dumps(dict(version=2, bindings=[binding]), indent=2)+"\n")
    (out/"Read-Only-Receipt.json").write_text(json.dumps(dict(
        status="EVIDENCE_COLLECTED_NOT_ACTIVATED", runtime_sha256=receipt["runtime_sha256"],
        deployment_evidence_sha256=digest(receipt_bytes), embedding_config_sha256=embedding_config_sha, lineage_evidence_sha256=digest(lineage_bytes),
        expires=now+seconds, remote_embedding_calls=0, generation_calls=0, data_writes=0,
        warning="Requires independent control-plane receipt review and exact Director Source/config/paid approval. No USD hard cap."), indent=2)+"\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-receipt", type=pathlib.Path, required=True)
    parser.add_argument("--document-id", action="append", required=True)
    parser.add_argument("--expires-seconds", type=int, default=600)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        attest(pathlib.Path.cwd(), args.runtime_receipt, args.document_id, args.expires_seconds, args.out)
    except Exception:
        # DB/driver exceptions can contain connection details; do not log them.
        raise SystemExit("EVIDENCE_COLLECTION_DENIED; no grant installed, no provider dispatch") from None
    print("READ_ONLY_EVIDENCE_CREATED; NOT_INSTALLED; NO_PAID_DISPATCH")
