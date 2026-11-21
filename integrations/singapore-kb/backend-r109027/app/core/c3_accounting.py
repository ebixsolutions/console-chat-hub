"""C3 request wiring to the accepted shared atomic Supabase guard; no local quota."""
from contextvars import ContextVar
from pathlib import Path
import hashlib
import json
import re
import requests
from fastapi.responses import Response
from app.core.shared_attempt_guard import SharedAttemptGuard, AccountingDenied, validate_scope, signed, PROTOCOL

COMPANY = '4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'
CALLBACK = 'https://nrfxhqabwblzxoushgnm.supabase.co/functions/v1/model-attempt-accounting'
_current = ContextVar('c3_provider_context', default=None)

def runtime_hash():
    root = Path(__file__).resolve().parents[2]
    files = sorted(root.glob('app/**/*.py')) + [root / 'requirements.txt']
    return hashlib.sha256(''.join(str(p.relative_to(root)) + ':' + hashlib.sha256(p.read_bytes()).hexdigest() + '\n' for p in files).encode()).hexdigest()

def checked_scope(raw, signature, secret, company_id):
    if not secret:
        raise AccountingDenied('credential')
    scope = validate_scope(raw, signature, secret)
    if (scope.get('tenant') != str(company_id) or scope.get('service') != 'kb'
        or not re.fullmatch(r'kb:[0-9a-f-]{36}', scope.get('operation', ''))
        or not re.fullmatch(r'[0-9a-f-]{36}', scope.get('nonce', ''))
        or not re.fullmatch(r'[0-9a-f]{64}', scope.get('request_sha256', ''))):
        raise AccountingDenied('tenant/operation/request scope')
    return scope

def make_contract(request, db):
    from app.models import Company
    raw = request.headers.get('x-c3-accounting-scope', '')
    signature = request.headers.get('x-c3-accounting-signature', '')
    try:
        tenant = json.loads(raw)['tenant']
        if not str(tenant).isdigit(): raise ValueError()
        company = db.query(Company).filter(Company.id == int(tenant)).first()
        if company is None: raise ValueError()
        scope = checked_scope(raw, signature, company.api_key, company.id)
    except Exception as exc:
        raise AccountingDenied('contract denied') from exc
    body = json.dumps({**scope, 'protocol': PROTOCOL, 'mode': 'shared_atomic_attempts', 'runtime_sha256': runtime_hash()}, separators=(',', ':'))
    return Response(body, media_type='application/json', headers={'x-c3-accounting-signature': signed(body, company.api_key), 'Cache-Control': 'no-store'})

def bind_request(request, company, secret, body):
    raw = request.headers.get('x-c3-accounting-scope')
    if not raw:
        if request.headers.get('x-ai-company-id') == COMPANY:
            raise AccountingDenied('missing scope')
        return _current.set(None)
    signature = request.headers.get('x-c3-accounting-signature', '')
    scope = checked_scope(raw, signature, secret, company.id)
    if request.headers.get('x-c3-accounting-mode') != 'shared_atomic_attempts':
        raise AccountingDenied('mode')
    # Raw byte digest is supplied by the ASGI middleware: preserves exact JS UTF-8 JSON.
    if request.scope.get('c3_request_sha256') != scope['request_sha256']:
        raise AccountingDenied('request integrity')
    guard = SharedAttemptGuard(raw, signature, secret, CALLBACK)
    return _current.set({'guard': guard, 'ordinal': 0})

def reset_request(token):
    if token is not None: _current.reset(token)

def provider_post(url, **kwargs):
    context = _current.get()
    if context is None:
        return requests.post(url, **kwargs)
    # These direct HTTP adapters perform exactly one dispatch (no SDK retry loop).
    context['ordinal'] += 1
    payload = json.dumps({'url': url, 'body': kwargs.get('json')}, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    provider = ('vertex_embedding' if url.endswith(':predict') else
                'vertex_generation' if ':generateContent' in url else
                'deepseek' if 'deepseek' in url else 'openai')
    identity = f"{context['guard'].scope['operation']}:{context['ordinal']}:{provider}"
    kwargs['allow_redirects'] = False
    return context['guard'].invoke(provider, identity, payload, lambda: requests.post(url, **kwargs))

class RequestDigestMiddleware:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or not scope['path'].endswith('/api/v1/rag/context-search'):
            return await self.app(scope, receive, send)
        messages = []
        data = bytearray()
        while True:
            message = await receive()
            messages.append(message)
            data.extend(message.get('body', b''))
            if message['type'] != 'http.request' or not message.get('more_body'): break
        scope['c3_request_sha256'] = hashlib.sha256(data).hexdigest()
        async def replay():
            if messages: return messages.pop(0)
            return await receive()
        return await self.app(scope, replay, send)
