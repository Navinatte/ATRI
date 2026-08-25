# Build stage: compile dependencies and wheels
FROM python:3.14-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-linux.txt .

RUN pip install --upgrade pip setuptools wheel \
    && pip wheel --no-cache-dir --no-deps --wheel-dir /build/wheels -r requirements-linux.txt

# Runtime stage: minimal final image
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ATRI_SOURCE_CONFIG_PATH=/app/assets/config.json \
    ATRI_RUNTIME_CONFIG_PATH=/tmp/atri-config.runtime.json \
    ATRI_CONFIG_PATH=/tmp/atri-config.runtime.json

WORKDIR /app

# Install runtime dependencies only (no build tools)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/wheels /wheels
COPY --from=builder /build/requirements-linux.txt .

RUN pip install --no-cache /wheels/*.whl

COPY . .

RUN chmod +x /app/docker/python/docker-entrypoint.sh

ENTRYPOINT ["/app/docker/python/docker-entrypoint.sh"]
