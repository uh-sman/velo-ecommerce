# Production image for apps/api.
#
#   docker build -f docker/api.Dockerfile -t velo-api:local .
#
# Multi-stage: the builder holds uv and the toolchain, the runtime holds the
# virtualenv and nothing else.

# ─── Builder ───────────────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS builder

COPY --from=ghcr.io/astral-sh/uv:0.7.20 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

# Build where it will run: a venv's console scripts (uvicorn) hard-code the
# interpreter path in their shebang, so a venv built in /build and copied to
# /app cannot start.
WORKDIR /app

# Dependencies first, in their own layer: application code changes on every
# commit, dependencies do not, so this layer stays cached.
COPY apps/api/pyproject.toml apps/api/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

COPY apps/api/ ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# ─── Runtime ───────────────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS runtime

# Non-root. A container process that does not need root does not get root.
RUN groupadd --system --gid 1001 velo \
    && useradd --system --uid 1001 --gid velo --create-home velo

RUN apt-get update \
    && apt-get install --no-install-recommends -y curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --no-editable installed velo into the venv itself: the venv is the whole app.
COPY --from=builder --chown=velo:velo /app/.venv /app/.venv

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER velo
EXPOSE 8000

# Liveness only — readiness is the orchestrator's separate probe against /ready.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl --fail http://localhost:8000/health || exit 1

# One worker per container; the orchestrator scales containers, not processes.
CMD ["uvicorn", "velo.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-server-header"]
