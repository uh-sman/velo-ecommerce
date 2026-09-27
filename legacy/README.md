# Legacy — Loyverse ↔ Cloudbeds bridge

**Archived. Not part of Velo Commerce. Nothing in this directory is imported, built, deployed, or tested.**

These files are the original FastAPI service that occupied this repository before it was repurposed: a webhook bridge that received Loyverse POS receipts and posted them to Cloudbeds as folio charges.

| File | Was |
|---|---|
| `main.py` | FastAPI app and webhook endpoint |
| `models.py` | Pydantic payload models |
| `loyverse.py` | Signature verification and mapping |
| `cloudbeds.py` | Cloudbeds API wrapper |
| `tasks.py` | Celery task with a background fallback |
| `Dockerfile` | Single-stage Python 3.11 image |
| `requirements.txt` | Unpinned dependency list |
| `.env.example` | Loyverse and Cloudbeds credentials template |

The functional description is preserved in [`../docs/legacy-loyverse-cloudbeds-bridge.md`](../docs/legacy-loyverse-cloudbeds-bridge.md).

**They were moved here, not deleted** (`PLANNING.md` 3.1), so that nothing is lost before someone who knows the deployment confirms it is retired. If that bridge is still running somewhere, extract this directory into its own repository. If it is not, delete this directory — the description in `docs/` is the archive that matters.

The root `.env.example` and `requirements.txt` in this directory are **not** the project's; those live at the repository root and in `apps/api/pyproject.toml`.
