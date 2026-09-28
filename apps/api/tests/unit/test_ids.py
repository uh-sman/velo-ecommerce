"""UUIDv7 generation (velo/db/ids.py)."""

from __future__ import annotations

import time

from velo.db.ids import uuid7, uuid7_timestamp_ms


def test_version_and_variant_bits_follow_rfc_9562() -> None:
    value = uuid7()

    assert value.version == 7
    assert value.variant == "specified in RFC 4122"


def test_embedded_timestamp_is_now() -> None:
    before = time.time_ns() // 1_000_000
    value = uuid7()
    after = time.time_ns() // 1_000_000

    assert before <= uuid7_timestamp_ms(value) <= after + 1


def test_ids_are_strictly_increasing_within_a_burst() -> None:
    """Same-millisecond IDs still sort in creation order — the B-tree locality we want."""
    ids = [uuid7() for _ in range(20_000)]

    assert ids == sorted(ids)
    assert len(set(ids)) == len(ids)
