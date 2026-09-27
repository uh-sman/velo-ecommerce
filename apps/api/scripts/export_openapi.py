"""Write the OpenAPI document to a file, without starting the server.

    uv run python scripts/export_openapi.py [output]   # default: openapi.json

The typed client in ``packages/api-client`` is generated from this document
(ADR-001), locally and in CI, so both must produce it the same way. Building
the schema never opens a connection, so placeholder settings are filled in for
anything the environment does not provide.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path

_PLACEHOLDERS = {
    "VELO_SECRET_KEY": "openapi-export-placeholder-secret-key",
    "VELO_DATABASE_URL": "postgresql+asyncpg://openapi:export@localhost:5432/unused",
}


def main() -> None:
    output = Path(sys.argv[1] if len(sys.argv) > 1 else "openapi.json")
    for name, value in _PLACEHOLDERS.items():
        os.environ.setdefault(name, value)

    # Imported here, after the environment is set: `velo.main` builds the app
    # at import time, which reads the settings.
    create_app = importlib.import_module("velo.main").create_app
    document = create_app().openapi()

    # Sorted and indented, so the generated client only changes when the API does.
    # LF even on Windows: CI diffs the client generated from this byte for byte.
    output.write_text(
        json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n"
    )


if __name__ == "__main__":
    main()
