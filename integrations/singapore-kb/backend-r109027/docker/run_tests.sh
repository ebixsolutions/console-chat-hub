#!/usr/bin/env bash
# 一鍵在乾淨容器內對真實 PG(pgvector)+Redis 跑全部驗證
set -e
python - <<'PY'
import time, os, sqlalchemy as sa
for i in range(60):
    try: sa.create_engine(os.environ["DATABASE_URL"]).connect().close(); break
    except Exception: time.sleep(1)
PY
alembic upgrade head
echo "=== schema equivalence (diff must be 0) ==="
python tests/verify_schema_equivalence.py
python tests/verify_entities.py
echo "=== integration + API contract (real PG+pgvector+Redis) ==="
python -m pytest tests/test_integration_real.py tests/test_api_contract.py -v
echo "=== original functional e2e ==="
DATABASE_URL="sqlite:///./_e2e.db" python -m pytest tests/test_e2e.py -q
echo "ALL VERIFICATION PASSED"
