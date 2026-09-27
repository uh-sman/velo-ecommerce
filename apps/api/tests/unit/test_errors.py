"""Every error leaves this API as RFC 9457 problem details (API-SPEC.md §1)."""

from __future__ import annotations

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from velo.core.errors import (
    ConflictError,
    DomainError,
    FieldError,
    NotFoundError,
    register_exception_handlers,
)


def test_domain_error_renders_a_problem_document() -> None:
    error = ConflictError("Only 2 units of SKU TSHIRT-NVY-L are available.")

    problem = error.to_problem(instance="/api/v1/cart/items")

    assert problem.type == "https://velo.dev/errors/conflict"
    assert problem.title == "Conflict"
    assert problem.status == 409
    assert problem.instance == "/api/v1/cart/items"
    assert problem.detail is not None


def test_field_errors_survive_onto_the_problem_document() -> None:
    error = NotFoundError(
        "No such variant.",
        errors=[FieldError(field="variant_id", code="not_found", message="Unknown variant.")],
    )

    problem = error.to_problem()

    assert problem.errors is not None
    assert problem.errors[0].field == "variant_id"


def test_unset_fields_are_omitted_rather_than_null() -> None:
    problem = NotFoundError().to_problem()

    payload = problem.model_dump(exclude_none=True)

    assert "detail" not in payload
    assert "errors" not in payload
    assert payload["status"] == 404


async def test_a_domain_error_raised_in_a_route_becomes_problem_json() -> None:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/boom")
    async def boom() -> None:
        raise ConflictError("Stock changed while you were deciding.")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        response = await client.get("/boom")

    assert response.status_code == 409
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["type"].endswith("/conflict")
    assert body["instance"] == "/boom"


async def test_an_unhandled_exception_returns_500_without_leaking_internals() -> None:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/explode")
    async def explode() -> None:
        raise RuntimeError("connection string postgres://user:hunter2@db/velo")

    # Starlette re-raises after the 500 handler responds (so servers can log it);
    # the transport must not turn that into a test failure.
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://t") as client:
        response = await client.get("/explode")

    assert response.status_code == 500
    body = response.text
    assert "hunter2" not in body
    assert "RuntimeError" not in body


def test_every_domain_error_declares_a_distinct_slug() -> None:
    subclasses = DomainError.__subclasses__()
    slugs = [cls.slug for cls in subclasses]

    assert len(slugs) == len(set(slugs)), "two domain errors share a type URI"
