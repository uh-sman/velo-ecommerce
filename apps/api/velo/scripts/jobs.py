"""The dead-letter queue for background jobs: ``uv run python -m velo.scripts.jobs``.

A queued job that failed every retry is kept in ``job_failures`` and an alert
goes out (platform/job_failures.py). Once the cause is fixed:

    python -m velo.scripts.jobs                 # list what is dead
    python -m velo.scripts.jobs --replay ID     # queue that job again
    python -m velo.scripts.jobs --replay-all    # queue every one

Replaying re-enqueues the job with its recorded arguments; the worker runs it
with a fresh set of retries. Jobs are idempotent (ADR-009), so a replay of
work that half-happened is safe.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import uuid

from arq import create_pool

from velo.core.config import get_settings
from velo.core.jobs import redis_settings
from velo.db.session import dispose_engine, init_engine
from velo.domains.platform.job_failures import dead_jobs, mark_replayed


async def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="List or replay dead-lettered jobs.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--replay", metavar="ID", type=uuid.UUID, help="replay one job")
    group.add_argument("--replay-all", action="store_true", help="replay every dead job")
    args = parser.parse_args(argv)

    settings = get_settings()
    init_engine(settings)
    try:
        dead = await dead_jobs(limit=500)
        if args.replay is None and not args.replay_all:
            for job in dead:
                sys.stdout.write(
                    f"{job.id}  {job.job}  {job.created_at:%Y-%m-%d %H:%M}  "
                    f"attempts={job.attempts}  {job.error[:120]}\n"
                )
            sys.stdout.write(f"{len(dead)} dead job(s).\n")
            return 0
        chosen = [job for job in dead if args.replay_all or job.id == args.replay]
        if not chosen:
            sys.stderr.write("No dead job with that id.\n")
            return 1
        pool = await create_pool(redis_settings(settings))
        try:
            for job in chosen:
                if await mark_replayed(job.id) is None:
                    continue
                await pool.enqueue_job(job.job, *job.args.get("args", []))
                sys.stdout.write(f"Replayed {job.id} ({job.job}).\n")
        finally:
            await pool.aclose()
        return 0
    finally:
        await dispose_engine()


def main() -> None:
    sys.exit(asyncio.run(_main(sys.argv[1:])))


if __name__ == "__main__":
    main()
