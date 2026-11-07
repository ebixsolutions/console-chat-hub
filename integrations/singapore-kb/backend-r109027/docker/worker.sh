#!/usr/bin/env bash
set -e
python - <<'PY'
import time, os, sqlalchemy as sa
for i in range(60):
    try: sa.create_engine(os.environ["DATABASE_URL"]).connect().close(); break
    except Exception: time.sleep(1)
PY
# --beat：同進程跑 celerybeat（publish_watchdog 每 30 秒 / website_crawl_poll 每 60 秒），
# 沒有 watchdog 的話卡住的操作只能靠手動 recover 端點恢復。
exec celery -A app.worker.celery_app worker --beat --loglevel=info
