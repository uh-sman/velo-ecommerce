"""/dev — development-only tools. Mounted only when ``VELO_ENV=development``.

``GET /dev/emails`` lists every email; ``GET /dev/emails/{kind}`` renders one
with its sample context, as HTML or (``?format=text``) as its plain-text
twin, so templates are reviewed in a browser without sending anything.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, PlainTextResponse, Response

from velo.api.deps import SessionDep, SettingsDep
from velo.core.errors import NotFoundError
from velo.domains.platform.settings import SettingsService
from velo.emails.render import KINDS, render

router = APIRouter(prefix="/dev", tags=["development"], include_in_schema=False)


@router.get("/emails", response_class=HTMLResponse)
async def list_emails() -> HTMLResponse:
    items = "".join(
        f'<li><a href="emails/{kind}">{kind}</a> ({spec.category}) · '
        f'<a href="emails/{kind}?format=text">text</a></li>'
        for kind, spec in KINDS.items()
    )
    return HTMLResponse(
        "<!doctype html><title>Email previews</title>"
        "<body style='font-family:system-ui;padding:2rem'><h1>Email previews</h1>"
        f"<ul>{items}</ul></body>"
    )


@router.get("/emails/{kind}")
async def preview_email(
    kind: str,
    session: SessionDep,
    settings: SettingsDep,
    format: Literal["html", "text"] = "html",  # noqa: A002 — the query parameter's name
) -> Response:
    spec = KINDS.get(kind)
    if spec is None:
        raise NotFoundError("No such email.")
    values = await SettingsService(session, settings).all()
    rendered = render(
        kind,
        spec.sample,
        store=values["store"],
        texts=values["emails"],
        unsubscribe_url="http://localhost:3000/unsubscribe?token=sample"
        if spec.category == "marketing"
        else None,
    )
    if format == "text":
        return PlainTextResponse(f"Subject: {rendered.subject}\n\n{rendered.text}")
    return HTMLResponse(rendered.html)
