"""Application factory.

``create_app`` builds a fully configured instance; nothing is created at import
time, so tests can build an app per configuration without process-global state.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import DEFAULT_EXCLUDED_CONTENT_TYPES, GZipMiddleware

import velo.db.models  # noqa: F401 — register every mapper; FKs cross domains
from velo import __version__
from velo.api import health
from velo.api.conditional import ConditionalGetMiddleware
from velo.api.csrf import CsrfMiddleware
from velo.api.deps import close_mailer, close_meili, close_payment_providers
from velo.api.openapi import install_openapi
from velo.api.v1.router import api_router
from velo.core.config import Settings, get_settings
from velo.core.errors import register_exception_handlers
from velo.core.jobs import close_jobs, init_jobs
from velo.core.logging import configure_logging, get_logger
from velo.core.middleware import CorrelationIdMiddleware
from velo.db.redis import close_redis, init_redis
from velo.db.session import dispose_engine, init_engine

logger = get_logger(__name__)

# Below this a gzip header and the CPU cost outweigh the bytes saved.
GZIP_MINIMUM_SIZE = 1000
# Formats that are compressed already; Starlette's list covers images and
# archives, not the packing-slip PDFs.
GZIP_EXCLUDED_CONTENT_TYPES = (*DEFAULT_EXCLUDED_CONTENT_TYPES, "application/pdf")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    configure_logging(
        level="DEBUG" if settings.debug else "INFO",
        json_output=settings.env != "development",
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        """Open shared resources on startup, close them on shutdown.

        Connections are established here rather than lazily per request, so a
        misconfigured database URL fails at boot instead of at first checkout.
        """
        init_engine(settings)
        init_redis(settings)
        await init_jobs(settings)
        logger.info("api_started", env=settings.env, version=__version__)
        try:
            yield
        finally:
            await close_meili()
            await close_payment_providers()
            await close_mailer()
            await close_jobs()
            await close_redis()
            await dispose_engine()
            logger.info("api_stopped")

    app = FastAPI(
        title="Velo Commerce API",
        version=__version__,
        description="Headless commerce API. See docs/API-SPEC.md for the contract.",
        lifespan=lifespan,
        # Interactive docs are useful in development and are an attack surface
        # in production, where the OpenAPI document is published deliberately.
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
        openapi_url="/openapi.json",
    )

    # The last middleware added is the outermost. Conditional GET is innermost,
    # so it hashes the JSON the route produced, before compression; GZip sits
    # directly outside it because ``BaseHTTPMiddleware`` (CSRF, correlation)
    # re-streams every body, which would defeat GZip's minimum size. CSRF's
    # 403 still passes back through correlation (request ID) and CORS (headers
    # the browser needs to read the error).
    app.add_middleware(
        ConditionalGetMiddleware,
        prefixes=[
            f"{settings.api_prefix}/{path}"
            for path in ("products", "collections", "categories", "search")
        ],
    )
    app.add_middleware(
        GZipMiddleware,
        minimum_size=GZIP_MINIMUM_SIZE,
        exclude_content_types=GZIP_EXCLUDED_CONTENT_TYPES,
    )
    app.add_middleware(CsrfMiddleware, settings=settings)
    app.add_middleware(CorrelationIdMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,  # cookie auth (ADR-008) requires it
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-CSRF-Token", "Idempotency-Key", "X-Request-ID"],
        expose_headers=["X-Request-ID", "Idempotency-Replayed", "Retry-After"],
        max_age=600,
    )

    register_exception_handlers(app)
    install_openapi(app)

    # Health checks are unversioned: orchestrators should not have to know the
    # API version to decide whether to kill a container.
    app.include_router(health.router)
    app.include_router(api_router, prefix=settings.api_prefix)
    if settings.env == "development":
        # Email previews and other tools that must never exist in production.
        from velo.api.v1 import dev

        app.include_router(dev.router, prefix=settings.api_prefix)

    return app


app = create_app()
