"""UUIDv7 identifiers (RFC 9562), generated in the application.

Every primary key is a UUIDv7 (DATA-MODEL.md §1): time-ordered, so inserts land
at the right-hand edge of the B-tree like a sequence would, without leaking
order volume the way a sequence does.

Python 3.12 has no ``uuid.uuid7``, and Postgres 16 has no ``uuidv7()`` — both
arrive later (3.14 and 18). The application generates IDs here; the first
migration defines a SQL ``uuidv7()`` so rows inserted outside the ORM get the
same kind of key.
"""

from __future__ import annotations

import os
import threading
import time
import uuid

_lock = threading.Lock()
_last_ms = 0
_counter = 0

_COUNTER_MAX = 0xFFF  # rand_a is 12 bits


def uuid7() -> uuid.UUID:
    """A UUIDv7, monotonic within this process.

    Layout: 48-bit Unix milliseconds · 4-bit version · 12-bit counter ·
    2-bit variant · 62 random bits. The counter (RFC 9562 §6.2, method 1) keeps
    IDs generated in the same millisecond strictly increasing; it starts at a
    random value below the midpoint so a burst cannot exhaust it.
    """
    global _last_ms, _counter

    with _lock:
        now_ms = time.time_ns() // 1_000_000
        if now_ms > _last_ms:
            _last_ms = now_ms
            _counter = int.from_bytes(os.urandom(2)) & 0x7FF
        else:
            # Same millisecond, or the clock stepped backwards: stay on the last
            # timestamp and count up, so ordering never goes backwards either.
            _counter += 1
            if _counter > _COUNTER_MAX:
                _last_ms += 1
                _counter = 0
        timestamp_ms, counter = _last_ms, _counter

    rand_b = int.from_bytes(os.urandom(8)) & ((1 << 62) - 1)
    value = (timestamp_ms & ((1 << 48) - 1)) << 80 | 0x7 << 76 | counter << 64 | 0b10 << 62 | rand_b
    return uuid.UUID(int=value)


def uuid7_timestamp_ms(value: uuid.UUID) -> int:
    """The Unix-millisecond timestamp embedded in a UUIDv7."""
    return value.int >> 80
