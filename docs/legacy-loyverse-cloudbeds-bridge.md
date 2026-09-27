# Loyverse ↔ Cloudbeds Bridge (FastAPI)

This repository contains a lightweight FastAPI middleware to bridge Loyverse POS events into Cloudbeds PMS.

Quick start

1. Copy `.env.example` to `.env` and set credentials:

   CLOUDBEDS_BASE_URL=https://api.cloudbeds.example
   CLOUDBEDS_API_TOKEN=your_token
   LOYVERSE_WEBHOOK_SECRET=your_loyverse_secret
   CELERY_ENABLED=false
   CELERY_BROKER_URL=redis://redis:6379/0

2. Install local dependencies:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

3. Run locally:

```bash
uvicorn main:app --reload
```

4. (Optional) Run Celery worker if `CELERY_ENABLED=true`:

```bash
celery -A tasks.celery worker --loglevel=info
```

Files

- `main.py`: FastAPI application and endpoints
- `models.py`: Pydantic models
- `cloudbeds.py`: Cloudbeds API wrapper
- `loyverse.py`: signature verification and mapping
- `tasks.py`: Celery task or fallback background poster

Notes

- Update `LOYVERSE_WEBHOOK_SECRET` and `CLOUDBEDS_*` variables before deploying.
- FastAPI exposes OpenAPI at `/docs` and `/openapi.json`.

---

> **Archived.** This document describes the original Loyverse ↔ Cloudbeds FastAPI bridge that occupied this repository before it was repurposed for the Velo Commerce e-commerce platform. It is kept for reference. The source files (`main.py`, `models.py`, `cloudbeds.py`, `loyverse.py`, `tasks.py`) are still at the repository root and should be removed or moved to a separate repository during Phase 3 of `PLANNING.md`.
