FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# 系統依賴（psycopg 需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libpq-dev curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir "psycopg[binary]" gunicorn

COPY . .

EXPOSE 8000

# 預設啟動：等 DB → alembic upgrade head → uvicorn
CMD ["bash", "docker/entrypoint.sh"]
