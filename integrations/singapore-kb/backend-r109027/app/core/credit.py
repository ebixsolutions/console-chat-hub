"""
外部平台 credit 計費回報 — 每次 Vertex AI / Firecrawl 呼叫後記錄用量。

呼叫 settings.credit_api_url
（預設 https://widget.ebixmall.com/su-platform-api/api/credit/transaction）：
  body: {
    "app_code": settings.credit_app_code,
    "quota": -usage,          # 負數 = 扣費
    "description": "API名稱调用消耗",
  }
  authorization: HS256 JWT（payload = {sub, company_id, exp}，以 settings.jwt_secret
    簽署 — 與平台簽發/驗證前端 token 使用同一把 secret，故平台可直接驗證）

best-effort：一律於背景 thread 送出，任何失敗僅 logger.warning，絕不影響主流程。
無 user context（如 Celery 背景任務）時不回報 — 無法歸屬費用。
"""
from __future__ import annotations
import logging
import os
import threading
import time
from datetime import datetime

import jwt
import requests

from app.core.config import settings

logger = logging.getLogger(__name__)

_CREDIT_TIMEOUT_S = 5.0

# ★ 平台 nginx 會攔截預設的 python-requests User-Agent（直接 404），
#   必須帶非 python 的 UA 才會被路由到後端 credit API。
_CREDIT_USER_AGENT = "nexus-kb-credit/1.0"

# credit 交易 request/response 日誌目錄（logs/credit/YYYY-MM-DD.txt）
_CREDIT_LOG_DIR = os.path.join(os.getcwd(), "logs", "credit")
os.makedirs(_CREDIT_LOG_DIR, exist_ok=True)


def _credit_log_line(line: str) -> None:
    """append 一筆到 logs/credit/{today}.txt；失敗僅 logger.warning，絕不影響主流程。"""
    try:
        fname = os.path.join(_CREDIT_LOG_DIR,
                             datetime.now().strftime("%Y-%m-%d") + ".txt")
        with open(fname, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as e:
        logger.warning("credit log write failed: %s", e)


def _sign_credit_token(user_id, company_id) -> str:
    """簽發給 credit API 的 HS256 JWT（sub=system_users.id, company_id=...）。

    sub 以 str 表示（JWT spec / pyjwt 要求 subject 為 string）。
    exp = 現在 + settings.credit_token_exp（以秒為單位的相對 TTL），避免
    固定絕對時間戳過期導致平台棄權（ticket：爬取後無 credit 交易）。
    """
    payload = {
        "sub": str(user_id),
        "company_id": int(company_id or 0),
        "exp": int(time.time()) + settings.credit_token_exp,
    }
    return jwt.encode(payload, settings.jwt_secret,
                      algorithm=settings.jwt_algorithm)


def report_credit_usage(user_id, company_id, *, usage: int, description: str) -> None:
    """回報一筆用量（quota = -usage）。任何失敗都不得打斷主流程。"""
    if not settings.credit_report_enabled:
        return
    if not user_id:
        logger.debug("skip credit report: no user context")
        return
    try:
        usage = int(usage)
    except (TypeError, ValueError):
        logger.warning("skip credit report: invalid usage=%r", usage)
        return
    if usage <= 0:
        return
    try:
        token = _sign_credit_token(user_id, company_id)
    except Exception as e:
        logger.warning("credit token sign failed: %s", e)
        return

    def _send():
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        body = {
            "app_code": settings.credit_app_code,
            "quota": -usage,
            "description": description,
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": _CREDIT_USER_AGENT,
        }
        token_payload = None
        try:
            token_payload = jwt.decode(token, settings.jwt_secret,
                                       algorithms=[settings.jwt_algorithm],
                                       options={"verify_exp": False})
        except Exception:
            token_payload = "<decode failed>"
        _credit_log_line(
            f"[{ts}] REQUEST url={settings.credit_api_url} "
            f"headers={headers} jwt_payload={token_payload} body={body}")
        try:
            resp = requests.post(
                settings.credit_api_url,
                headers=headers,
                json=body,
                timeout=_CREDIT_TIMEOUT_S,
            )
            _credit_log_line(
                f"[{ts}] RESPONSE status_code={resp.status_code} "
                f"body={resp.text}")
        except Exception as e:
            _credit_log_line(f"[{ts}] RESPONSE error={e!r}")
            logger.warning("credit report failed: %s", e)

    try:
        threading.Thread(target=_send, daemon=True).start()
    except Exception as e:
        logger.warning("credit report thread start failed: %s", e)
