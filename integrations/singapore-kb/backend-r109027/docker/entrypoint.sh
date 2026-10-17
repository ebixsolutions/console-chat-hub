#!/usr/bin/env bash
set -e
echo "[entrypoint] waiting for postgres..."
python - <<'PY'
import time, os
import sqlalchemy as sa
url = os.environ["DATABASE_URL"]
for i in range(60):
    try:
        sa.create_engine(url).connect().close()
        print("postgres ready"); break
    except Exception as e:
        time.sleep(1)
else:
    raise SystemExit("postgres not reachable")
PY
echo "[entrypoint] alembic upgrade head..."
alembic upgrade head
echo "[entrypoint] starting API..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
