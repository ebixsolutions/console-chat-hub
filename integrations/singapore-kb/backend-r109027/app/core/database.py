"""
DB session 管理（SQLAlchemy 2.x，psycopg3）
"""
from __future__ import annotations
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.models import Base

engine = create_engine(
    settings.database_url,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_pre_ping=True,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False,
                            future=True, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    """FastAPI dependency。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    """背景任務 / 腳本用。"""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def create_all() -> None:
    """測試 / 首次啟動用；生產走 alembic。"""
    Base.metadata.create_all(bind=engine)
