"""The published OpenAPI document says what errors really look like.

FastAPI documents a ``422`` with its own validation-error shape and nothing
else. This API answers every error — validation included — as RFC 9457
problem details (``velo/core/errors.py``), with whatever status fits: 401,
403, 404, 409, 429 and so on. So every operation documents ``422`` and a
``default`` response as ``application/problem+json`` with the
:class:`ProblemDetail` schema. The contract tests (schemathesis) hold the
API to exactly this, and the generated TypeScript client types its errors
from it.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi

from velo.core.errors import PROBLEM_CONTENT_TYPE, ProblemDetail

# For routes whose success is not JSON (or not only JSON): ``responses=`` on the route.
CSV: dict[int | str, dict[str, Any]] = {
    200: {"content": {"text/csv": {"schema": {"type": "string"}}}, "description": "CSV"}
}
PDF: dict[int | str, dict[str, Any]] = {
    200: {
        "content": {"application/pdf": {"schema": {"type": "string", "format": "binary"}}},
        "description": "A PDF document",
    }
}
PROMETHEUS: dict[int | str, dict[str, Any]] = {
    200: {
        "content": {"text/plain": {"schema": {"type": "string"}}},
        "description": "JSON, or the Prometheus text format with ?format=prometheus",
    }
}

_METHODS = frozenset({"get", "put", "post", "patch", "delete", "head", "options"})
_REF = "#/components/schemas/{model}"


def _problem(description: str) -> dict[str, Any]:
    return {
        "description": description,
        "content": {PROBLEM_CONTENT_TYPE: {"schema": {"$ref": _REF.format(model="ProblemDetail")}}},
    }


def build_openapi(app: FastAPI) -> dict[str, Any]:
    schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )
    components = schema.setdefault("components", {}).setdefault("schemas", {})
    problem = ProblemDetail.model_json_schema(ref_template=_REF)
    components.update(problem.pop("$defs", {}))
    components["ProblemDetail"] = problem

    for item in schema.get("paths", {}).values():
        for method, operation in item.items():
            if method not in _METHODS:
                continue
            responses = operation.setdefault("responses", {})
            responses["422"] = _problem("The request is invalid: field errors in `errors`")
            responses["default"] = _problem("Any other error, as RFC 9457 problem details")

    # FastAPI's own validation-error shapes are never sent; don't publish them.
    for name in ("HTTPValidationError", "ValidationError"):
        components.pop(name, None)
    return schema


def install_openapi(app: FastAPI) -> None:
    def openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            app.openapi_schema = build_openapi(app)
        return app.openapi_schema

    app.openapi = openapi  # type: ignore[method-assign]
