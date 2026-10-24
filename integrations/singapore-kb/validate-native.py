"""Disposable localhost-only PostgreSQL fixtures for actual KB/RPC integration."""
import os, subprocess, sys
from pathlib import Path
from urllib.parse import urlparse
import psycopg
from psycopg import sql
repo = Path(__file__).resolve().parents[2]
kb = Path(__file__).resolve().parent / 'backend-r109027'
server = os.environ['C3_KB_TEST_SERVER_URL']
parsed = urlparse(server)
assert parsed.hostname in ('127.0.0.1', 'localhost')
with psycopg.connect(server, autocommit=True) as db:
    for name in ['c3kbaccounting', 'c3kbfixture']:
        db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
accounting = server.rsplit('/', 1)[0] + '/c3kbaccounting'
fixture = server.rsplit('/', 1)[0] + '/c3kbfixture'
with psycopg.connect(accounting, autocommit=True) as db:
    db.execute((repo / 'tests/model-accounting/bootstrap.sql').read_text())
    db.execute((repo / 'supabase/migrations/20261011002343_c3_shared_model_attempt_accounting.sql').read_text())
env = {**os.environ, 'DATABASE_URL': fixture.replace('postgres://', 'postgresql://').replace('postgresql://', 'postgresql+psycopg://'), 'C3_ACCOUNTING_TEST_DB_URL': accounting, 'CREDIT_REPORT_ENABLED': 'false', 'ENV': 'test', 'PYTHONDONTWRITEBYTECODE': '1'}
result = subprocess.run([sys.executable, '-m', 'pytest', 'tests/test_c3_accounting.py', '-q', '--tb=short'], cwd=kb, env=env)
raise SystemExit(result.returncode)
