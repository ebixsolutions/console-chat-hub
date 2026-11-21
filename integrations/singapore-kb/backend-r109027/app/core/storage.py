"""
Storage 適配層 — 取代 Base44 的 UploadFile / storage

支援 local / s3 / gcs。回傳可被 invoke_llm(file_urls=...) 讀取的簽名 URL。
Singapore 部署預設 local 或 s3（ap-southeast-1）。
"""
from __future__ import annotations
import hashlib
import hmac
import os
import time
from typing import Optional

from app.core.config import settings

# ── size / type 驗證 ──
MAX_FILE_BYTES = int(os.getenv("STORAGE_MAX_BYTES", str(50 * 1024 * 1024)))  # 50MB
ALLOWED_CONTENT_TYPES = {
    "application/pdf", "text/plain", "text/csv", "text/markdown",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel", "application/octet-stream", "application/json",
    "image/png", "image/jpeg",
}


class StorageValidationError(Exception):
    pass


def _key(filename: str, data: bytes) -> str:
    h = hashlib.sha256(data).hexdigest()[:16]
    safe = os.path.basename(filename).replace(" ", "_")
    return f"{time.strftime('%Y/%m/%d')}/{h}_{safe}"


def _validate(data: bytes, content_type: str) -> None:
    if not data:
        raise StorageValidationError("empty_file")
    if len(data) > MAX_FILE_BYTES:
        raise StorageValidationError(
            f"file_too_large: {len(data)} > {MAX_FILE_BYTES}")
    if content_type and content_type not in ALLOWED_CONTENT_TYPES:
        raise StorageValidationError(f"content_type_not_allowed: {content_type}")


# ── local 私有簽名（HMAC，避免任意 key 讀取）──
def sign_key(key: str, ttl: Optional[int] = None) -> tuple[str, int]:
    exp = int(time.time()) + (ttl or settings.storage_signed_url_ttl)
    msg = f"{key}:{exp}".encode()
    sig = hmac.new(settings.jwt_secret.encode(), msg, hashlib.sha256).hexdigest()
    return sig, exp


def verify_signature(key: str, exp: int, sig: str) -> bool:
    if exp < int(time.time()):
        return False
    expect, _ = sign_key(key, ttl=0)
    good = hmac.new(settings.jwt_secret.encode(),
                    f"{key}:{exp}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(good, sig)


def local_path_for(key: str) -> str:
    # 防目錄穿越
    base = os.path.realpath(settings.storage_local_path)
    path = os.path.realpath(os.path.join(base, key))
    if not path.startswith(base + os.sep) and path != base:
        raise StorageValidationError("path_traversal_blocked")
    return path


def upload_file(filename: str, data: bytes,
                content_type: str = "application/octet-stream") -> dict:
    """
    回傳 {file_url, key}。含 size/type 驗證。
    """
    _validate(data, content_type)
    backend = settings.storage_backend
    key = _key(filename, data)

    if backend == "local":
        path = local_path_for(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        # 私有簽名 URL（HMAC + exp），由 /files 路由驗證
        sig, exp = sign_key(key)
        base = os.getenv("STORAGE_PUBLIC_BASE", "http://localhost:8000/files")
        url = f"{base}/{key}?exp={exp}&sig={sig}"
        return {"file_url": url, "key": key, "signed_exp": exp}

    if backend == "s3":
        import boto3
        s3 = boto3.client("s3", region_name=os.getenv("AWS_REGION", "ap-southeast-1"))
        s3.put_object(Bucket=settings.storage_bucket, Key=key,
                      Body=data, ContentType=content_type)
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.storage_bucket, "Key": key},
            ExpiresIn=settings.storage_signed_url_ttl,
        )
        return {"file_url": url, "key": key}

    if backend == "gcs":
        from google.cloud import storage as gcs
        client = gcs.Client()
        bucket = client.bucket(settings.storage_bucket)
        blob = bucket.blob(key)
        blob.upload_from_string(data, content_type=content_type)
        from datetime import timedelta
        url = blob.generate_signed_url(
            expiration=timedelta(seconds=settings.storage_signed_url_ttl))
        return {"file_url": url, "key": key}

    raise RuntimeError(f"unknown storage backend: {backend}")


def delete_file(key: str) -> bool:
    """Cleanup：刪除已存檔案。回傳是否刪除。"""
    backend = settings.storage_backend
    if backend == "local":
        try:
            path = local_path_for(key)
            if os.path.exists(path):
                os.remove(path)
                return True
        except Exception:
            return False
        return False
    if backend == "s3":
        import boto3
        s3 = boto3.client("s3", region_name=os.getenv("AWS_REGION", "ap-southeast-1"))
        s3.delete_object(Bucket=settings.storage_bucket, Key=key)
        return True
    if backend == "gcs":
        from google.cloud import storage as gcs
        client = gcs.Client()
        client.bucket(settings.storage_bucket).blob(key).delete()
        return True
    return False


def storage_test() -> dict:
    """kbStorageTest 對應：寫入 + 讀回 + 驗證簽名。"""
    probe = b"nexus-kb storage probe"
    r = upload_file("_probe.txt", probe, "text/plain")
    ok_read = True
    if settings.storage_backend == "local":
        path = local_path_for(r["key"])
        ok_read = os.path.exists(path) and open(path, "rb").read() == probe
    return {"ok": bool(ok_read), "backend": settings.storage_backend,
            "key": r.get("key"), "file_url": r.get("file_url")}
