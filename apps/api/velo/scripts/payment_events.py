"""The dead-letter queue for payment webhooks: ``uv run python -m velo.scripts.payment_events``.

A webhook that failed processing five times is dead-lettered and an alert
goes out (PAYMENTS-AND-CHECKOUT.md §6.4). Once the cause is fixed:

    python -m velo.scripts.payment_events              # list what is dead-lettered
    python -m velo.scripts.payment_events --replay ID  # retry one event now
    python -m velo.scripts.payment_events --replay-all # retry every one

Replaying is safe: an event is applied once however often it is replayed, and
settlement is idempotent (checkout/settlement.py). Exit status 1 means some
event still failed.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import uuid

from velo.core.config import get_settings
from velo.db.redis import close_redis, init_redis
from velo.db.session import dispose_engine, init_engine, open_session
from velo.domains.payments.service import PaymentService


async def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="List or replay dead-lettered payment events.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--replay", metavar="ID", type=uuid.UUID, help="replay one event")
    group.add_argument("--replay-all", action="store_true", help="replay every dead event")
    args = parser.parse_args(argv)

    from velo.worker import Worker  # imported late: --help needs no settings

    settings = get_settings()
    init_engine(settings)
    init_redis(settings)
    worker = Worker(settings)
    try:
        async with open_session() as session:
            dead = await PaymentService(session).dead_events()
        if args.replay is None and not args.replay_all:
            for event in dead:
                sys.stdout.write(
                    f"{event.id}  {event.provider}  {event.event_type}  "
                    f"{event.provider_event_id}  {event.processing_error or ''}\n"
                )
            sys.stdout.write(f"{len(dead)} dead-lettered event(s).\n")
            return 0

        targets = [args.replay] if args.replay else [event.id for event in dead]
        failures = 0
        for event_id in targets:
            async with open_session() as session:
                await PaymentService(session).requeue(event_id)
                await session.commit()
                outcome = await worker.event_processor(session).process(event_id)
            sys.stdout.write(f"{event_id}: {outcome}\n")
            failures += outcome not in ("processed", "done")
        return 1 if failures else 0
    finally:
        await worker.providers.aclose()
        await worker.meili.aclose()
        await close_redis()
        await dispose_engine()


def main() -> None:
    raise SystemExit(asyncio.run(_main(sys.argv[1:])))


if __name__ == "__main__":
    main()
