"""Rebuild the search index from Postgres: ``uv run python -m velo.scripts.reindex``.

Safe against production (ADR-007): a fresh index is built beside the live one
and swapped in atomically, so searches are answered throughout. Writes made
during the build are re-synced after the swap.

``--check`` only reports drift between the index and Postgres; exit status 1
means they disagree.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from velo.core.config import get_settings
from velo.core.meili import SearchUnavailableError
from velo.db.redis import close_redis, init_redis
from velo.db.session import dispose_engine, init_engine, session_scope


async def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Rebuild or check the product search index.")
    parser.add_argument("--check", action="store_true", help="report drift; change nothing")
    args = parser.parse_args(argv)

    # Imported here so --help works without the settings a worker needs.
    from velo.worker import Worker, rebuild_index

    settings = get_settings()
    init_engine(settings)
    init_redis(settings)
    worker = Worker(settings)
    try:
        if args.check:
            async with session_scope() as session:
                missing, stale = await worker.indexer(session).differences()
            sys.stdout.write(
                f"Missing from the index: {len(missing)}. Stale in it: {len(stale)}.\n"
            )
            return 1 if missing or stale else 0
        result = await rebuild_index(worker)
        sys.stdout.write(
            f"Indexed {result['indexed']} of {result['live_products']} live products; "
            f"re-synced {result['caught_up']} changed during the build.\n"
        )
        return 0
    except SearchUnavailableError as exc:
        sys.stderr.write(f"Meilisearch is unavailable: {exc}\n")
        return 2
    finally:
        await worker.meili.aclose()
        await close_redis()
        await dispose_engine()


def main() -> None:
    raise SystemExit(asyncio.run(_main(sys.argv[1:])))


if __name__ == "__main__":
    main()
