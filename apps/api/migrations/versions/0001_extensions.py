"""Extensions and the uuidv7() function every table's primary key defaults to.

``citext`` — case-insensitive email and discount-code columns, with no
``LOWER()`` indexes to keep in step. ``ltree`` — category paths.

Postgres 16 has no ``uuidv7()`` (it arrives in 18). This one follows RFC 9562:
48 bits of Unix milliseconds over a random v4 UUID, with the version nibble
rewritten from 4 to 7. The application generates its own IDs (velo/db/ids.py);
this default covers rows inserted outside the ORM. On Postgres 18 the built-in
in ``pg_catalog`` takes precedence over this one.

Revision ID: 0001
Revises:
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")
    op.execute("CREATE EXTENSION IF NOT EXISTS ltree")
    op.execute(
        """
        CREATE FUNCTION uuidv7() RETURNS uuid
        LANGUAGE sql VOLATILE PARALLEL SAFE
        AS $$
            SELECT encode(
                set_bit(
                    set_bit(
                        overlay(
                            uuid_send(gen_random_uuid())
                            PLACING substring(
                                int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
                                FROM 3
                            )
                            FROM 1 FOR 6
                        ),
                        52, 1
                    ),
                    53, 1
                ),
                'hex'
            )::uuid
        $$
        """
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION uuidv7()")
    op.execute("DROP EXTENSION IF EXISTS ltree")
    op.execute("DROP EXTENSION IF EXISTS citext")
