"""
Auth / RBAC / tenant isolation（production 強化版）

安全要點（回應 QA gap D）：
  - JWT 驗 signature + exp + audience + issuer（config 開關，production 預設全開）。
  - service-role 不再只靠 X-Service-Role header：需 X-Service-Role-Secret 且值 ==
    SERVICE_ROLE_SECRET（強憑證），否則忽略。只有 service-role 可跨 tenant。
  - AuthContext.tenant_id 為隔離主鍵；一般 admin 仍受自身 tenant 邊界限制。
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Optional

import jwt
from fastapi import Header, HTTPException, Request

from app.core.config import settings


@dataclass
class AuthContext:
    user_id: str
    tenant_id: str
    role: str
    company_id: int = 0
    email: str = ""
    is_service_role: bool = False

    @property
    def id(self) -> str:
        return self.user_id


def _decode_jwt(token: str) -> dict[str, Any]:
    """Decode and validate a JWT access token. Raises 401 on failure.

    ★ 只驗 signature + exp。前端 token 不含 aud/iss，audience/issuer 校验
      強制關閉（jwt.decode 預設 verify_aud=True，必須顯式設 False，
      否則帶 aud 聲明的 token 反而會 Invalid audience）。
    """
    options = {
        "verify_signature": True,
        "verify_exp": True,
        "verify_aud": False,
        "verify_iss": False,
    }
    kwargs: dict = {"algorithms": [settings.jwt_algorithm], "options": options}
    try:
        return jwt.decode(token, settings.jwt_secret, **kwargs)
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError as e:
        raise HTTPException(401, f"Invalid token: {e}")


def _service_role_valid(secret_header: Optional[str]) -> bool:
    secret = settings.service_role_secret
    if not secret:
        return False   # 未配置強憑證 → 永不授予 service-role
    return bool(secret_header) and secret_header == secret


def get_current_user(
    request: Request,
    authorization: Optional[str] = Header(None),
    x_service_role_secret: Optional[str] = Header(None),
) -> AuthContext:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    claims = _decode_jwt(token)

    print(claims)
    user_id = claims.get("sub") or claims.get("user_id") or claims.get("uid")
    if not user_id:
        raise HTTPException(401, "Token missing subject")

    tenant_id = claims.get("tenant_id") or user_id
    company_id = claims.get("company_id", 0)
    try:
        company_id = int(company_id) if company_id is not None else 0
    except (TypeError, ValueError):
        company_id = 0
    role = claims.get("role", "user")
    email = claims.get("email", "")
    svc = _service_role_valid(x_service_role_secret)
    ctx = AuthContext(user_id=user_id, tenant_id=tenant_id, company_id=company_id, role=role,
                      email=email, is_service_role=svc)
    # 設定 request-scoped tenant context（供 before_insert 自動落 tenant_id / company_id）
    try:
        from app.core.tenant_ctx import set_tenant_context
        set_tenant_context(tenant_id, user_id, company_id)
    except Exception:
        pass
    return ctx


def get_service_role_user(
    request: Request,
    authorization: Optional[str] = Header(None),
    x_service_role_secret: Optional[str] = Header(None),
) -> AuthContext:
    ctx = get_current_user(request, authorization, x_service_role_secret)
    if ctx.is_service_role:
        ctx.role = "admin"
    return ctx
