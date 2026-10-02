"""Settings fail fast, and refuse to be unsafe in production."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from velo.core.config import Settings


def _settings(**overrides: str) -> Settings:
    values = {
        "env": "development",
        "secret_key": "a-secret-key-that-is-long-enough-to-pass",
        "database_url": "postgresql+asyncpg://velo:velo@localhost:5432/velo",
    }
    values.update(overrides)
    # No env files: a developer's .env (VELO_DEBUG=true, say) must not decide
    # which production rule fires first.
    return Settings(_env_file=None, **values)  # type: ignore[arg-type]


def test_missing_required_setting_fails_at_construction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("VELO_SECRET_KEY", raising=False)
    monkeypatch.delenv("VELO_DATABASE_URL", raising=False)
    # Away from the repo, so a developer's real .env cannot satisfy the settings.
    # Two levels deep, so both `.env` and `../../.env` resolve inside tmp_path.
    empty_dir = tmp_path / "apps" / "api"
    empty_dir.mkdir(parents=True)
    monkeypatch.chdir(empty_dir)

    with pytest.raises(ValidationError):
        Settings()


def test_sync_database_driver_is_rejected() -> None:
    with pytest.raises(ValidationError, match="asyncpg"):
        _settings(database_url="postgresql://velo:velo@localhost:5432/velo")


def test_cors_origins_parse_from_a_comma_separated_string() -> None:
    settings = _settings(cors_origins="http://a.test, http://b.test")

    assert settings.cors_origins == ["http://a.test", "http://b.test"]


def test_cors_origins_parse_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    # The environment path differs from the constructor path: pydantic-settings
    # JSON-decodes list fields read from env vars unless they are marked NoDecode.
    monkeypatch.setenv("VELO_SECRET_KEY", "a-secret-key-that-is-long-enough-to-pass")
    monkeypatch.setenv("VELO_DATABASE_URL", "postgresql+asyncpg://velo:velo@localhost:5432/velo")
    monkeypatch.setenv("VELO_CORS_ORIGINS", "http://a.test, http://b.test")

    assert Settings().cors_origins == ["http://a.test", "http://b.test"]


def test_production_refuses_debug() -> None:
    with pytest.raises(ValidationError, match="debug"):
        _settings(env="production", debug="true")


def test_production_refuses_insecure_cookies() -> None:
    with pytest.raises(ValidationError, match="cookie_secure"):
        _settings(env="production", cookie_secure="false")


def test_production_refuses_a_short_secret_key() -> None:
    with pytest.raises(ValidationError, match="secret_key"):
        _settings(env="production", secret_key="too-short")


def test_development_tolerates_what_production_refuses() -> None:
    settings = _settings(env="development", debug="true", secret_key="short")

    assert settings.debug is True
    assert settings.is_production is False


def test_the_repo_root_env_file_is_read_when_running_from_apps_api(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # README: `cp .env.example .env` at the root, then run the API from apps/api.
    for key in ("VELO_SECRET_KEY", "VELO_DATABASE_URL"):
        monkeypatch.delenv(key, raising=False)
    (tmp_path / ".env").write_text(
        "VELO_SECRET_KEY=a-secret-key-that-is-long-enough-to-pass\n"
        "VELO_DATABASE_URL=postgresql+asyncpg://velo:velo@localhost:5432/from_root\n"
    )
    api_dir = tmp_path / "apps" / "api"
    api_dir.mkdir(parents=True)
    monkeypatch.chdir(api_dir)

    assert Settings().database_url.endswith("/from_root")

    # A local apps/api/.env overrides the root one.
    (api_dir / ".env").write_text(
        "VELO_DATABASE_URL=postgresql+asyncpg://velo:velo@localhost:5432/from_local\n"
    )
    assert Settings().database_url.endswith("/from_local")


def test_production_refuses_the_payment_sandbox() -> None:
    with pytest.raises(ValidationError, match="payment_sandbox"):
        _settings(env="production", payment_sandbox="true")
