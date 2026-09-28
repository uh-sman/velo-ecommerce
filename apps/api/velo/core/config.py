"""Application settings.

Every setting is typed and validated at import. A missing or malformed required
variable stops the process at startup with a readable message, rather than
surfacing as an `AttributeError` inside a checkout three hours later.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

Environment = Literal["development", "staging", "production"]


class Settings(BaseSettings):
    """Runtime configuration, read from the environment (prefix ``VELO_``)."""

    model_config = SettingsConfigDict(
        env_prefix="VELO_",
        # The README puts one .env at the repo root, and the API runs from
        # apps/api. Later files win, so an apps/api/.env can override. Paths
        # are relative to the working directory; missing files are skipped.
        env_file=("../../.env", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        frozen=True,
    )

    # ── Core ───────────────────────────────────────────────────────────────
    env: Environment = "development"
    debug: bool = False
    secret_key: SecretStr
    api_prefix: str = "/api/v1"

    # ── Database ───────────────────────────────────────────────────────────
    database_url: str
    database_pool_size: int = Field(default=10, ge=1, le=100)
    database_max_overflow: int = Field(default=5, ge=0, le=100)
    database_echo: bool = False

    # ── Redis ──────────────────────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379/0"

    # ── Search ─────────────────────────────────────────────────────────────
    meilisearch_url: str = "http://localhost:7700"
    meilisearch_master_key: SecretStr = SecretStr("")

    # ── Auth (ADR-008) ─────────────────────────────────────────────────────
    access_token_ttl_seconds: int = Field(default=900, ge=60)
    refresh_token_ttl_seconds: int = Field(default=2_592_000, ge=3600)
    cookie_domain: str = "localhost"
    cookie_secure: bool = True

    # Password policy: reject passwords found in known breaches (Have I Been
    # Pwned, k-anonymity — only a 5-character hash prefix leaves the server).
    breach_check_enabled: bool = True
    # Behind a trusted proxy the client address is in X-Forwarded-For; trusting
    # that header without a proxy lets any caller choose their own rate-limit key.
    trust_forwarded_for: bool = False

    # ── Email (Phase 12 moves sending to a background worker) ──────────────
    smtp_host: str = "localhost"
    smtp_port: int = Field(default=1025, ge=1, le=65535)
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    smtp_use_tls: bool = False
    email_from: str = "orders@velo.example"
    # Where links in emails point: verify-email and reset-password pages.
    storefront_url: str = "http://localhost:3000"

    # ── CORS ───────────────────────────────────────────────────────────────
    # NoDecode: without it pydantic-settings JSON-decodes list fields from the
    # environment before `_split_origins` runs, and a plain URL is not JSON.
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        """Accept a comma-separated string, because that is what a .env holds."""
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("database_url")
    @classmethod
    def _require_async_driver(cls, value: str) -> str:
        if not value.startswith("postgresql+asyncpg://"):
            raise ValueError(
                "database_url must use the asyncpg driver "
                "(postgresql+asyncpg://…). A sync driver blocks the event loop."
            )
        return value

    @model_validator(mode="after")
    def _production_is_not_negotiable(self) -> Settings:
        """Settings that are merely inadvisable in development are refused in production."""
        if self.env != "production":
            return self

        if self.debug:
            raise ValueError("debug must be false in production — it leaks internals in errors.")
        if not self.cookie_secure:
            raise ValueError("cookie_secure must be true in production.")
        if len(self.secret_key.get_secret_value()) < 32:
            raise ValueError("secret_key must be at least 32 characters in production.")
        return self

    @property
    def is_production(self) -> bool:
        return self.env == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached accessor. Overridden in tests by clearing the cache."""
    return Settings()  # values come from the environment
