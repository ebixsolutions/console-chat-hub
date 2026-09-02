#!/usr/bin/env python3
from __future__ import annotations
import json, os, subprocess, sys, tempfile, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = os.getenv('B31_SINGAPORE_BASE_URL', 'https://py.ebixmall.com/py-knowledge-base').rstrip('/')
STOP = 78


def out(msg: str): print(msg, flush=True)
def fail(msg: str): out('FAIL_B31_' + msg); raise SystemExit(1)
def stop(msg: str): out('STOP_B31_' + msg); raise SystemExit(STOP)


def request(path: str, method='GET', body=None, headers=None, timeout=25):
    """Use curl for the same network semantics as prior successful production probes.

    Secret headers are passed as subprocess argv and are never logged/printed.
    Response bodies are written to a private temp file and only parsed in-memory.
    """
    with tempfile.TemporaryDirectory(prefix='b31-http-') as td:
        response_file = Path(td) / 'response.bin'
        body_file = Path(td) / 'body.json'
        cmd = [
            'curl', '-sS', '-L', '--max-time', str(timeout),
            '-o', str(response_file), '-w', '%{http_code}',
            '-X', method,
            '-H', 'accept: application/json',
        ]
        if body is not None:
            body_file.write_text(json.dumps(body, separators=(',', ':')))
            os.chmod(body_file, 0o600)
            cmd += ['-H', 'content-type: application/json', '--data-binary', '@' + str(body_file)]
        for key, value in (headers or {}).items():
            cmd += ['-H', f'{key}: {value}']
        cmd.append(BASE + path)
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode != 0:
            fail(f'NETWORK_CURL_{p.returncode}')
        try:
            status = int((p.stdout or '').strip())
        except Exception:
            fail('NETWORK_HTTP_STATUS_INVALID')
        raw = response_file.read_bytes() if response_file.exists() else b''
        try:
            payload = json.loads(raw) if raw else None
        except Exception:
            payload = None
        return status, payload


def control_headers():
    for name in ('SINGAPORE_SERVICE_ROLE_SECRET','KB_SINGAPORE_SERVICE_ROLE_SECRET','SERVICE_ROLE_SECRET','KB_REVIEW_EXECUTOR_SERVICE_SECRET'):
        value = (os.getenv(name) or '').strip()
        if value:
            return {'x-service-role-secret': value}, 'service_role'
    value = (os.getenv('SINGAPORE_BACKEND_TOKEN') or '').strip()
    if value:
        return {'authorization': 'Bearer ' + value}, 'bearer'
    return None, None


def rows(payload):
    if isinstance(payload, list): return payload
    if not isinstance(payload, dict): return []
    for key in ('data','entities','documents','results','items'):
        if isinstance(payload.get(key), list): return payload[key]
    return []


# Single canonical gate owns source contract + production runtime checks.
subprocess.run([sys.executable, str(ROOT/'tests/b3-1-review-executor-source-contract.py'), str(ROOT)], check=True)

status, spec = request('/openapi.json')
if status != 200 or not isinstance(spec, dict): fail(f'OPENAPI_HTTP_{status}')
paths = spec.get('paths') or {}
if '/api/entities/KBDocument' not in paths: fail('CONTROL_ENTITY_ROUTE_MISSING')
review_path = '/api/functions/kbReviewExecute'
if review_path not in paths:
    stop('SVN_DEPLOYMENT_REQUIRED_REVIEW_ROUTE_MISSING')
out('B31_REVIEW_ROUTE_PRESENT=YES')

# Server-only endpoint must reject anonymous traffic before request validation.
status, _ = request(review_path, 'POST', {})
if status not in (401, 403): fail(f'ANONYMOUS_REVIEW_NOT_DENIED_HTTP_{status}')
out('B31_ANONYMOUS_DENIAL=PASS')

headers, kind = control_headers()
if not headers:
    stop('INFRA_CONTROL_CREDENTIAL_UNAVAILABLE')
out('B31_CONTROL_CREDENTIAL_KIND=' + kind)

# Authenticated invalid payload proves the credential reaches request validation without mutating data.
status, _ = request(review_path, 'POST', {}, headers)
if status in (401,403): fail(f'CONTROL_CREDENTIAL_REJECTED_HTTP_{status}')
if status == 404: fail('REVIEW_ROUTE_DEPLOYMENT_DRIFT')
if status >= 500: fail(f'AUTHENTICATED_ROUTE_HTTP_{status}')
if status not in (400,409,422): fail(f'INVALID_PAYLOAD_NOT_REJECTED_HTTP_{status}')
out('B31_AUTHENTICATED_ROUTE_SMOKE=PASS')

# Product-ready B3.1 requires a real disposable, explicitly approved review fixture.
fixture = {
    'document_id': (os.getenv('B31_SMOKE_DOCUMENT_ID') or '').strip(),
    'expected_global_document_id': (os.getenv('B31_SMOKE_GLOBAL_DOCUMENT_ID') or '').strip(),
    'expected_version': (os.getenv('B31_SMOKE_VERSION') or '').strip(),
    'expected_content_hash': (os.getenv('B31_SMOKE_CONTENT_HASH') or '').strip().lower(),
}
if not all(fixture.values()):
    stop('REAL_REVIEW_FIXTURE_NOT_CONFIGURED')
if len(fixture['expected_content_hash']) != 64:
    fail('SMOKE_CONTENT_HASH_INVALID')
try: uuid.UUID(fixture['expected_global_document_id'])
except Exception: fail('SMOKE_GLOBAL_DOCUMENT_ID_INVALID')

idem = 'b31-smoke:' + fixture['expected_global_document_id'] + ':' + fixture['expected_version'] + ':' + fixture['expected_content_hash']
payload = {
    **fixture,
    'review_mode': 'smart',
    'idempotency_key': idem,
}
status, first = request(review_path, 'POST', payload, headers, timeout=120)
if status != 200 or not isinstance(first, dict) or first.get('ok') is not True:
    fail(f'REAL_REVIEW_HTTP_{status}')
review_id = str(first.get('review_id') or '').strip()
decision = str(first.get('publish_decision') or '').strip()
if not review_id: fail('REAL_REVIEW_ID_MISSING')
if decision not in ('ready','ready_with_review'):
    fail('REAL_REVIEW_NOT_PUBLISHABLE_' + (decision or 'UNKNOWN'))
out('B31_REAL_REVIEW_EXECUTION=PASS')

# Idempotent replay must reuse the same review, not duplicate agent results.
status, second = request(review_path, 'POST', payload, headers, timeout=120)
if status != 200 or not isinstance(second, dict) or second.get('ok') is not True:
    fail(f'IDEMPOTENT_REPLAY_HTTP_{status}')
if str(second.get('review_id') or '') != review_id:
    fail('IDEMPOTENT_REVIEW_ID_CHANGED')
if second.get('idempotent') is not True:
    fail('IDEMPOTENT_REPLAY_FLAG_FALSE')
out('B31_REVIEW_IDEMPOTENCY=PASS')

# Authoritative read-back: same-version/hash terminal KBReview and real KBAgentResult rows.
status, review_payload = request('/api/entities/KBReview', headers=headers)
if status != 200: fail(f'KBREVIEW_READBACK_HTTP_{status}')
matching_reviews = [r for r in rows(review_payload) if str(r.get('id')) == review_id]
if len(matching_reviews) != 1: fail('KBREVIEW_READBACK_NOT_EXACTLY_ONE')
review = matching_reviews[0]
if str(review.get('document_id') or '') != fixture['document_id']: fail('KBREVIEW_DOCUMENT_BINDING_MISMATCH')
if str(review.get('review_version') or review.get('version') or '') != fixture['expected_version']: fail('KBREVIEW_VERSION_BINDING_MISMATCH')
review_hash = str(review.get('content_hash') or review.get('review_content_hash') or review.get('expected_content_hash') or '').lower()
if review_hash and review_hash != fixture['expected_content_hash']: fail('KBREVIEW_HASH_BINDING_MISMATCH')
terminal = str(review.get('overall_status') or review.get('status') or '').lower()
if terminal not in ('passed','passed_with_warnings','completed','ready','ready_with_review'): fail('KBREVIEW_NOT_TERMINAL')

status, result_payload = request('/api/entities/KBAgentResult', headers=headers)
if status != 200: fail(f'KBAGENTRESULT_READBACK_HTTP_{status}')
agent_rows = [r for r in rows(result_payload) if str(r.get('review_id') or '') == review_id]
if not agent_rows: fail('REAL_AGENT_RESULTS_MISSING')
agent_keys = {str(r.get('agent_key') or '').strip() for r in agent_rows}
if not any(k.startswith('industry_') for k in agent_keys): fail('INDUSTRY_AGENT_RESULT_MISSING')
if not any(('conflict' in k) for k in agent_keys): fail('CONFLICT_AGENT_RESULT_MISSING')
if not any(('version' in k) for k in agent_keys): fail('VERSION_AGENT_RESULT_MISSING')
out('B31_REAL_REVIEW_PROVENANCE_READBACK=PASS')
out('B3_1_FINAL_STATUS=READY')
