import os
from typing import Dict

CELERY_ENABLED = os.getenv("CELERY_ENABLED", "false").lower() in ("1", "true", "yes")

if CELERY_ENABLED:
    from celery import Celery
    celery = Celery("bridge", broker=os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0"))

    @celery.task(bind=True, max_retries=3)
    def post_charge_task(self, charge: Dict):
        from cloudbeds import CloudbedsClient
        cb = CloudbedsClient()
        try:
            # cloudbeds client methods are async; for tasks run a simple sync wrapper using httpx
            import asyncio
            return asyncio.get_event_loop().run_until_complete(cb.post_add_charge(charge))
        except Exception as e:
            raise self.retry(exc=e, countdown=60)

    def enqueue_post_charge(charge: Dict):
        post_charge_task.delay(charge)

else:
    # Fallback: simple background queueing using a spawned thread (best-effort)
    from threading import Thread
    import asyncio

    def _sync_post(charge: Dict):
        from cloudbeds import CloudbedsClient
        cb = CloudbedsClient()
        asyncio.run(cb.post_add_charge(charge))

    def enqueue_post_charge(charge: Dict):
        Thread(target=_sync_post, args=(charge,), daemon=True).start()
