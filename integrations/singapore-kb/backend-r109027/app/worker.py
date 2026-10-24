"""
Celery worker — 取代 Base44 Deno waitUntil 背景執行

啟動：
    celery -A app.worker.celery_app worker -Q kb -l info
    celery -A app.worker.celery_app beat -l info
"""
from __future__ import annotations
from celery import Celery

from app.core.config import settings

celery_app = Celery(
    "nexus_kb",
    broker=settings.celery_broker,
    backend=settings.celery_backend,
)

celery_app.conf.update(
    task_default_queue="kb",
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="Asia/Singapore",
    enable_utc=True,
    task_track_started=True,
    worker_max_tasks_per_child=200,
    beat_schedule={
        "kb-publish-watchdog": {
            "task": "kb.publish_watchdog",
            "schedule": 30.0,          # 每 30 秒
        },
        "kb-website-crawl-poll": {
            "task": "kb.website_crawl_poll",
            "schedule": 60.0,
        },
    },
)

# 註冊任務（import 即註冊）
import app.tasks.publish_tasks       # noqa: E402,F401
import app.tasks.import_tasks        # noqa: E402,F401
import app.tasks.website_tasks       # noqa: E402,F401

# LLM 註冊（import_pipeline 的 AI 分類需要，worker 進程同 main.py）
from app.core.llm import invoke_llm                     # noqa: E402
from app.services.import_pipeline import register_llm    # noqa: E402
register_llm(lambda prompt, **kw: invoke_llm(prompt, **kw))
