"""
API 異常/報錯日誌

將 API 例外/錯誤寫入專案根目錄 logs/uvicorn/YYYY_MM_DD.txt。
每筆日誌包含：時間、API 路徑、傳參、報錯資訊，並以 2 個空行結尾，保持可讀性。
"""
from __future__ import annotations

import json
import logging
import threading
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import Request
from fastapi.exceptions import RequestValidationError

logger = logging.getLogger("nexus_kb.error")

LOG_ROOT = Path(__file__).resolve().parent.parent.parent / "logs" / "uvicorn"

_WRITE_LOCK = threading.Lock()
_MAX_BODY = 4000  # 避免過大 body 塞爆日誌

# scope 中用來暫存 request body 的 key（供錯誤 handler 取用）
_BODY_SCOPE_KEY = "_api_error_body"


class BodyCaptureMiddleware:
    """
    在 scope 中緩衝完整 request body。

    目的：ServerErrorMiddleware 對未處理例外只會建立 Request(scope)（無 receive），
    且端點未必有讀取 body；此 middleware 先收完整個 body 放入 scope，
    讓錯誤 handler 即使 body 已被消費仍能記錄傳參。僅作錯誤日誌輔助用。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.request":
                body.extend(message.get("body", b""))
                if not message.get("more_body", False):
                    break
            else:
                break
        scope[_BODY_SCOPE_KEY] = bytes(body)

        body_bytes = bytes(body)
        sent = False

        async def receive_wrapper():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body_bytes, "more_body": False}
            return {"type": "http.disconnect"}

        await self.app(scope, receive_wrapper, send)


def _log_file() -> Path:
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    return LOG_ROOT / f"{datetime.now().strftime('%Y_%m_%d')}.txt"


def _status_of(exc: Exception) -> int:
    if isinstance(exc, RequestValidationError):
        return 422
    status = getattr(exc, "status_code", None)
    return status if isinstance(status, int) else 500


async def _read_body(request: Request) -> Optional[Any]:
    """讀取 request body：優先取 BodyCaptureMiddleware 緩衝的完整 body。"""
    raw_buf = request.scope.get(_BODY_SCOPE_KEY)
    if raw_buf:
        try:
            return json.loads(raw_buf)
        except Exception:
            return raw_buf.decode("utf-8", errors="replace")
    try:
        return await request.json()
    except Exception:
        pass
    try:
        raw = getattr(request, "_body", None)
        if raw:
            return raw.decode("utf-8", errors="replace")
    except Exception:
        pass
    return None


async def _fmt_params(request: Request) -> str:
    parts: list[str] = []
    qp = dict(request.query_params)
    if qp:
        parts.append("query=" + json.dumps(qp, ensure_ascii=False, default=str))
    body = await _read_body(request)
    if body is not None:
        text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False, default=str)
        if len(text) > _MAX_BODY:
            text = text[:_MAX_BODY] + "...(truncated)"
        parts.append("body=" + text)
    return "  ".join(parts) if parts else "(无)"


async def log_api_error(request: Request, exc: Exception) -> None:
    """組裝並寫入一筆 API 錯誤日誌；任何失敗都不影響原請求回應。"""
    try:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")
        msg = str(exc) or type(exc).__name__
        entry = "\n".join([
            f"[时间] {now}",
            f"[API路径] {request.method} {request.url.path}",
            f"[传参] {await _fmt_params(request)}",
            f"[报错] {type(exc).__name__}({_status_of(exc)}): {msg}",
        ])
        tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).strip()
        if tb:
            entry += "\n" + tb
        entry += "\n\n\n"  # 結束後換 2 行，保持可讀性
    except Exception:
        logger.exception("組裝 API 錯誤日誌失敗")
        return

    # 同時保留在 uvicorn console，避免 traceback 被吞掉
    logger.error(entry.strip())
    try:
        with _WRITE_LOCK:
            with open(_log_file(), "a", encoding="utf-8") as f:
                f.write(entry)
    except Exception as e:
        logger.exception("寫入 API 錯誤日誌失敗: %s", e)
