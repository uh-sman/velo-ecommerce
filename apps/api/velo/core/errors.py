"""RFC 9457 problem details — the only error shape this API emits.

Services raise :class:`DomainError` subclasses and know nothing about HTTP
(ARCHITECTURE.md §3, rule 2). The handlers registered here translate them into
``application/problem+json`` responses carrying the correlation ID.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from velo.core.logging import get_logger, get_request_id

logger = get_logger(__name__)

PROBLEM_CONTENT_TYPE = "application/problem+json"
ERROR_TYPE_BASE = "https://velo.dev/errors"


class FieldError(BaseModel):
    """One field-level validation failure, for a form to render inline."""

    field: str
    code: str
    message: str


class ProblemDetail(BaseModel):
    """RFC 9457 problem details, plus the correlation ID and field errors."""

    type: str
    title: str
    status: int
    detail: str | None = None
    instance: str | None = None
    request_id: str | None = None
    errors: list[FieldError] | None = Field(default=None)


class DomainError(Exception):
    """Base for every business-rule failure.

    Subclasses set the status, the stable ``slug`` (which becomes the ``type``
    URI a client can branch on), and a human-readable title.
    """

    status_code: int = status.HTTP_400_BAD_REQUEST
    slug: str = "bad-request"
    title: str = "Bad request"

    def __init__(
        self,
        detail: str | None = None,
        *,
        errors: list[FieldError] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(detail or self.title)
        self.detail = detail
        self.errors = errors
        self.headers = headers or {}

    def to_problem(self, instance: str | None = None) -> ProblemDetail:
        return ProblemDetail(
            type=f"{ERROR_TYPE_BASE}/{self.slug}",
            title=self.title,
            status=self.status_code,
            detail=self.detail,
            instance=instance,
            request_id=get_request_id(),
            errors=self.errors,
        )


class NotFoundError(DomainError):
    """404 — also used where a resource exists but is not the caller's.

    Returning 403 for someone else's order confirms that it exists, which is an
    information leak. It is simply not found (API-SPEC.md §1).
    """

    status_code = status.HTTP_404_NOT_FOUND
    slug = "not-found"
    title = "Not found"


class ConflictError(DomainError):
    """409 — the request is valid but the current state refuses it."""

    status_code = status.HTTP_409_CONFLICT
    slug = "conflict"
    title = "Conflict"


class ValidationError(DomainError):
    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    slug = "validation-failed"
    title = "Validation failed"


class UnauthenticatedError(DomainError):
    status_code = status.HTTP_401_UNAUTHORIZED
    slug = "unauthenticated"
    title = "Not authenticated"


class ForbiddenError(DomainError):
    status_code = status.HTTP_403_FORBIDDEN
    slug = "forbidden"
    title = "Not permitted"


class DependencyUnavailableError(DomainError):
    """503 — a dependency we need is not answering. Retryable."""

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    slug = "dependency-unavailable"
    title = "Dependency unavailable"


def _problem_response(
    problem: ProblemDetail, headers: dict[str, str] | None = None
) -> JSONResponse:
    return JSONResponse(
        status_code=problem.status,
        content=problem.model_dump(exclude_none=True),
        media_type=PROBLEM_CONTENT_TYPE,
        headers=headers,
    )


async def domain_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, DomainError)
    problem = exc.to_problem(instance=request.url.path)
    logger.info(
        "domain_error",
        slug=exc.slug,
        status=exc.status_code,
        path=request.url.path,
        detail=exc.detail,
    )
    return _problem_response(problem, headers=exc.headers)


async def http_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Translate framework-raised HTTP errors into the same envelope.

    Without this, a 404 from the router and a 404 from a service would have two
    different shapes, and every client would need to handle both.
    """
    assert isinstance(exc, StarletteHTTPException)
    detail = exc.detail if isinstance(exc.detail, str) else None
    problem = ProblemDetail(
        type=f"{ERROR_TYPE_BASE}/http-{exc.status_code}",
        title=_TITLES.get(exc.status_code, "Request failed"),
        status=exc.status_code,
        detail=detail,
        instance=request.url.path,
        request_id=get_request_id(),
    )
    return _problem_response(problem, headers=getattr(exc, "headers", None))


async def validation_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """422 with per-field errors the form can render inline."""
    assert isinstance(exc, RequestValidationError)
    field_errors = [
        FieldError(
            field=".".join(str(part) for part in error["loc"][1:]) or str(error["loc"][0]),
            code=str(error["type"]),
            message=str(error["msg"]),
        )
        for error in exc.errors()
    ]
    problem = ProblemDetail(
        type=f"{ERROR_TYPE_BASE}/validation-failed",
        title="Validation failed",
        status=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail="One or more fields are invalid.",
        instance=request.url.path,
        request_id=get_request_id(),
        errors=field_errors,
    )
    return _problem_response(problem)


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """500 — logged with the traceback, returned without one.

    The client gets a correlation ID and nothing else. Stack traces in a
    response body are a reconnaissance gift.
    """
    logger.exception("unhandled_exception", path=request.url.path, exc_type=type(exc).__name__)
    problem = ProblemDetail(
        type=f"{ERROR_TYPE_BASE}/internal-error",
        title="Internal server error",
        status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="An unexpected error occurred. Quote the request ID when reporting it.",
        instance=request.url.path,
        request_id=get_request_id(),
    )
    return _problem_response(problem)


_TITLES: dict[int, str] = {
    400: "Bad request",
    401: "Not authenticated",
    403: "Not permitted",
    404: "Not found",
    405: "Method not allowed",
    409: "Conflict",
    410: "Gone",
    422: "Validation failed",
    429: "Too many requests",
    500: "Internal server error",
    503: "Dependency unavailable",
}


def register_exception_handlers(app: FastAPI) -> None:
    handlers: dict[Any, Any] = {
        DomainError: domain_error_handler,
        StarletteHTTPException: http_exception_handler,
        RequestValidationError: validation_exception_handler,
        Exception: unhandled_exception_handler,
    }
    for exc_class, handler in handlers.items():
        app.add_exception_handler(exc_class, handler)
