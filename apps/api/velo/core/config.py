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
    # An alias-like stable name; a full reindex builds a sibling and swaps (ADR-007).
    meilisearch_index: str = "products"
    # Beyond this, search falls back to Postgres rather than keep the shopper waiting.
    meilisearch_timeout_seconds: float = Field(default=1.5, gt=0, le=30)
    # Reuse connections for searches. Off by default: see velo/core/meili.py.
    meilisearch_search_keepalive: bool = False

    # ── Catalog ────────────────────────────────────────────────────────────
    # Exact stock is shown only at or below this (API-SPEC.md §2, "Catalog").
    stock_display_threshold: int = Field(default=20, ge=0)
    catalog_cache_ttl_seconds: int = Field(default=300, ge=0)  # 0 disables the cache
    # Who hears about low stock. Empty: logged only.
    ops_alert_email: str | None = None

    # ── Cart (Phase 7) ─────────────────────────────────────────────────────
    currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")
    # A cart with items, untouched this long, is marked abandoned (for recovery email).
    cart_abandon_after_hours: int = Field(default=24, ge=1)

    # ── Checkout & payments (Phase 8, ADR-006) ─────────────────────────────
    # How long a checkout holds its stock (PAYMENTS-AND-CHECKOUT.md §2).
    checkout_ttl_minutes: int = Field(default=30, ge=1, le=24 * 60)
    stripe_secret_key: SecretStr = SecretStr("")
    stripe_publishable_key: str = ""
    stripe_webhook_secret: SecretStr = SecretStr("")
    stripe_api_base: str = "https://api.stripe.com"
    paystack_secret_key: SecretStr = SecretStr("")  # also signs Paystack's webhooks
    paystack_public_key: str = ""
    paystack_api_base: str = "https://api.paystack.co"
    # Which provider takes a currency; anything unlisted goes to the default.
    payment_default_provider: Literal["stripe", "paystack", "sandbox"] = "stripe"
    # A provider that never leaves the building, for E2E and load tests (payments/sandbox.py).
    # Refused in production.
    payment_sandbox: bool = False
    payment_currency_providers: Annotated[dict[str, str], NoDecode] = Field(
        default_factory=lambda: dict.fromkeys(("NGN", "GHS", "ZAR", "KES"), "paystack")
    )
    # Reconciliation asks the provider about payments unsettled for this long (§7).
    payment_reconcile_after_minutes: int = Field(default=30, ge=1)

    # ── Orders, fulfilment and returns (Phase 9) ───────────────────────────
    store_name: str = "Velo"
    # Printed on return labels; "|" separates lines in a .env.
    return_address: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["Velo Returns", "1 Warehouse Way", "San Francisco, CA 94103", "US"]
    )
    return_window_days: int = Field(default=30, ge=0)
    # Signs carrier tracking webhooks (HMAC-SHA256 of the raw body). Empty: endpoint off.
    tracking_webhook_secret: SecretStr = SecretStr("")

    # ── Media storage (S3 or R2; MinIO in development) ─────────────────────
    s3_endpoint_url: str | None = None  # None = AWS; set for R2 or MinIO
    s3_region: str = "auto"
    s3_bucket: str = "velo-media"
    s3_access_key_id: SecretStr = SecretStr("")
    s3_secret_access_key: SecretStr = SecretStr("")
    # Where the browser fetches media from: a CDN in production.
    media_public_url: str = "http://localhost:9000/velo-media"
    media_max_upload_bytes: int = Field(default=20 * 1024 * 1024, ge=1)

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
    # Where staff links point: invitations.
    admin_url: str = "http://localhost:3001"
    # The API's public origin, for links that point at it (one-click unsubscribe).
    public_api_url: str = "http://localhost:8000"
    # Resend (production email). Empty key: SMTP is used instead (MailHog in development).
    resend_api_key: SecretStr = SecretStr("")
    resend_api_base: str = "https://api.resend.com"
    # Svix secret ("whsec_…") signing Resend's delivery webhooks. Empty: endpoint off.
    resend_webhook_secret: SecretStr = SecretStr("")

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

    @field_validator("return_address", mode="before")
    @classmethod
    def _split_return_address(cls, value: object) -> object:
        if isinstance(value, str):
            return [line.strip() for line in value.split("|") if line.strip()]
        return value

    @field_validator("payment_currency_providers", mode="before")
    @classmethod
    def _split_currency_providers(cls, value: object) -> object:
        """``NGN:paystack,GHS:paystack`` — the shape a .env can hold."""
        if isinstance(value, str):
            pairs = [item.split(":", 1) for item in value.split(",") if item.strip()]
            return {code.strip().upper(): name.strip().lower() for code, name in pairs}
        return value

    @field_validator("payment_currency_providers")
    @classmethod
    def _known_providers(cls, value: dict[str, str]) -> dict[str, str]:
        unknown = {name for name in value.values() if name not in ("stripe", "paystack")}
        if unknown:
            raise ValueError(f"unknown payment provider(s): {', '.join(sorted(unknown))}")
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
        if self.payment_sandbox:
            raise ValueError("payment_sandbox must be false in production: it takes no money.")
        if self.stripe_secret_key.get_secret_value() and not (
            self.stripe_webhook_secret.get_secret_value()
        ):
            # Without it every webhook is refused, and no order is ever created.
            raise ValueError("stripe_webhook_secret is required when Stripe is configured.")
        return self

    @property
    def is_production(self) -> bool:
        return self.env == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached accessor. Overridden in tests by clearing the cache."""
    return Settings()  # values come from the environment
