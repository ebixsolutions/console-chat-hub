"""
/files 路由 — local storage 的私有簽名檔案服務。

回應 QA gap #4：local 模式必須實際 mount 並安全提供檔案，
需 signed access（HMAC + exp）、防目錄穿越、僅 local backend 啟用。
"""
from __future__ import annotations
import os

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from app.core.config import settings
from app.core import storage

router = APIRouter(tags=["files"])


@router.get("/files/{key:path}")
def serve_file(key: str, exp: int = Query(...), sig: str = Query(...)):
    if settings.storage_backend != "local":
        raise HTTPException(404, "not_found")
    if not storage.verify_signature(key, exp, sig):
        raise HTTPException(403, "invalid_or_expired_signature")
    try:
        path = storage.local_path_for(key)
    except storage.StorageValidationError:
        raise HTTPException(400, "bad_key")
    if not os.path.exists(path):
        raise HTTPException(404, "not_found")
    return FileResponse(path)
