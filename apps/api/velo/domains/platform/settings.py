"""Store settings an operator edits in the admin, and what the platform reports about itself.

Two documents: ``store`` (name, contact, address) and ``emails`` (the words
in customer emails). Each is merged over defaults, so a key added in code
works before anyone has saved the form. Payment providers are reported, not
edited: keys are secrets and stay in the environment.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from velo.core.config import Settings
from velo.domains.platform.events import Actor, diff, record_audit
from velo.domains.platform.models import StoreSetting

SECTIONS = ("store", "emails")


def defaults(settings: Settings) -> dict[str, dict[str, Any]]:
    return {
        "store": {
            "name": settings.store_name,
            "support_email": settings.email_from,
            "phone": "",
            "address": list(settings.return_address),
            "currency": settings.currency,  # read-only: prices are stored in it
            "return_window_days": settings.return_window_days,  # read-only: set in the environment
        },
        "emails": {
            "order_confirmed_intro": (
                "Thank you — your payment went through and your order is confirmed."
            ),
            "order_shipped_intro": "Good news — your order has shipped.",
            "signature": f"The {settings.store_name} team",
        },
    }


READ_ONLY = {"store": {"currency", "return_window_days"}, "emails": set()}


class SettingsService:
    def __init__(self, session: AsyncSession, settings: Settings) -> None:
        self._session = session
        self._settings = settings

    async def all(self) -> dict[str, dict[str, Any]]:
        stored = {
            row.key: dict(row.value)
            for row in (await self._session.scalars(select(StoreSetting))).all()
        }
        merged = defaults(self._settings)
        for section in SECTIONS:
            editable = {
                k: v for k, v in stored.get(section, {}).items() if k not in READ_ONLY[section]
            }
            merged[section] = {**merged[section], **editable}
        return merged

    async def update(self, section: str, changes: dict[str, Any], actor: Actor) -> dict[str, Any]:
        current = (await self.all())[section]
        allowed = set(defaults(self._settings)[section]) - READ_ONLY[section]
        updated = {**current, **{k: v for k, v in changes.items() if k in allowed}}
        stored = {k: v for k, v in updated.items() if k not in READ_ONLY[section]}
        await self._session.execute(
            insert(StoreSetting)
            .values(key=section, value=stored, updated_by=actor.user_id)
            .on_conflict_do_update(
                index_elements=["key"],
                set_={
                    "value": stored,
                    "updated_by": actor.user_id,
                    "updated_at": datetime.now(UTC),
                },
            )
        )
        record_audit(
            self._session,
            actor,
            f"settings.{section}_updated",
            "store_settings",
            None,
            diff(current, updated),
        )
        await self._session.commit()
        return updated

    def payment_providers(self) -> list[dict[str, Any]]:
        """Configured or not, and test or live — never a key."""
        stripe_key = self._settings.stripe_publishable_key
        return [
            {
                "name": "stripe",
                "configured": bool(self._settings.stripe_secret_key.get_secret_value()),
                "webhook_configured": bool(self._settings.stripe_webhook_secret.get_secret_value()),
                "mode": "live"
                if stripe_key.startswith("pk_live_")
                else "test"
                if stripe_key
                else None,
                "default": self._settings.payment_default_provider == "stripe",
                "currencies": sorted(
                    c for c, p in self._settings.payment_currency_providers.items() if p == "stripe"
                ),
            },
            {
                "name": "paystack",
                "configured": bool(self._settings.paystack_secret_key.get_secret_value()),
                "webhook_configured": bool(self._settings.paystack_secret_key.get_secret_value()),
                "mode": "live"
                if self._settings.paystack_public_key.startswith("pk_live_")
                else "test"
                if self._settings.paystack_public_key
                else None,
                "default": self._settings.payment_default_provider == "paystack",
                "currencies": sorted(
                    c
                    for c, p in self._settings.payment_currency_providers.items()
                    if p == "paystack"
                ),
            },
        ]


async def email_texts(session: AsyncSession, settings: Settings) -> dict[str, Any]:
    """The words for customer emails, for the worker."""
    return (await SettingsService(session, settings).all())["emails"]
