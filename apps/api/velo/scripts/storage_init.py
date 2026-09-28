"""Create the media bucket if it is missing: ``uv run python -m velo.scripts.storage_init``.

Idempotent. In development this prepares the local S3 container; in production
the bucket normally exists already and this confirms the credentials work.
"""

from __future__ import annotations

import sys

from botocore.exceptions import BotoCoreError, ClientError

from velo.core.config import get_settings
from velo.core.storage import MediaStorage


def main() -> None:
    settings = get_settings()
    try:
        created = MediaStorage(settings).ensure_bucket()
    except (BotoCoreError, ClientError) as exc:
        sys.stderr.write(f"Could not reach the bucket {settings.s3_bucket!r}: {exc}\n")
        raise SystemExit(1) from exc
    sys.stdout.write(
        f"Bucket {settings.s3_bucket!r} {'created' if created else 'already exists'}.\n"
    )


if __name__ == "__main__":
    main()
