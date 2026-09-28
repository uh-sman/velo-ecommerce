"""Object storage for product media: S3, R2, or a local S3 in development.

Uploads never pass through the API. The admin asks for a presigned POST, the
browser sends the file straight to the bucket, and the POST policy — signed
here — makes the bucket itself refuse a file over the size limit or of the
wrong type. The API then records the object and the worker derives resized
copies from it.

boto3 is synchronous. Presigning is local computation (no network), so it is
called directly; the calls that do I/O run in a thread.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from velo.core.config import Settings

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client
    from mypy_boto3_s3.type_defs import ObjectIdentifierTypeDef

PRESIGN_TTL_SECONDS = 600


@dataclass(frozen=True, slots=True)
class PresignedUpload:
    url: str
    fields: dict[str, str]
    key: str
    public_url: str
    expires_in: int
    max_bytes: int


class MediaStorage:
    def __init__(self, settings: Settings) -> None:
        self._bucket = settings.s3_bucket
        self._public_base = settings.media_public_url.rstrip("/")
        self._max_bytes = settings.media_max_upload_bytes
        self._client: S3Client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key_id.get_secret_value() or None,
            aws_secret_access_key=settings.s3_secret_access_key.get_secret_value() or None,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},  # R2 and local servers want path style
                retries={"max_attempts": 3, "mode": "standard"},
                connect_timeout=3,
                read_timeout=15,
            ),
        )

    @property
    def max_bytes(self) -> int:
        return self._max_bytes

    def public_url(self, key: str) -> str:
        return f"{self._public_base}/{key}"

    def key_from_url(self, url: str) -> str | None:
        """The object key behind one of our public URLs; None for a foreign URL."""
        prefix = f"{self._public_base}/"
        return url.removeprefix(prefix) if url.startswith(prefix) else None

    def presign_upload(self, key: str, content_type: str) -> PresignedUpload:
        post = self._client.generate_presigned_post(
            Bucket=self._bucket,
            Key=key,
            Fields={"Content-Type": content_type},
            Conditions=[
                {"Content-Type": content_type},
                ["content-length-range", 1, self._max_bytes],
            ],
            ExpiresIn=PRESIGN_TTL_SECONDS,
        )
        return PresignedUpload(
            url=post["url"],
            fields={name: str(value) for name, value in post["fields"].items()},
            key=key,
            public_url=self.public_url(key),
            expires_in=PRESIGN_TTL_SECONDS,
            max_bytes=self._max_bytes,
        )

    async def get(self, key: str) -> bytes:
        def _get() -> bytes:
            return self._client.get_object(Bucket=self._bucket, Key=key)["Body"].read()

        return await asyncio.to_thread(_get)

    async def exists(self, key: str) -> bool:
        def _head() -> bool:
            try:
                self._client.head_object(Bucket=self._bucket, Key=key)
            except ClientError:
                return False
            return True

        return await asyncio.to_thread(_head)

    async def put(self, key: str, body: bytes, content_type: str) -> str:
        def _put() -> None:
            self._client.put_object(
                Bucket=self._bucket,
                Key=key,
                Body=body,
                ContentType=content_type,
                # Derivatives are content-addressed by key and never overwritten.
                CacheControl="public, max-age=31536000, immutable",
            )

        await asyncio.to_thread(_put)
        return self.public_url(key)

    async def delete_prefix(self, prefix: str) -> None:
        def _delete() -> None:
            listing = self._client.list_objects_v2(Bucket=self._bucket, Prefix=prefix)
            keys: list[ObjectIdentifierTypeDef] = [
                {"Key": item["Key"]} for item in listing.get("Contents", [])
            ]
            if keys:
                self._client.delete_objects(Bucket=self._bucket, Delete={"Objects": keys})

        await asyncio.to_thread(_delete)

    def ensure_bucket(self) -> bool:
        """Create the bucket if missing, readable anonymously. True if it was created."""
        try:
            self._client.head_bucket(Bucket=self._bucket)
            return False
        except ClientError:
            self._client.create_bucket(Bucket=self._bucket)
        policy: dict[str, Any] = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": "*",
                    "Action": ["s3:GetObject"],
                    "Resource": [f"arn:aws:s3:::{self._bucket}/*"],
                }
            ],
        }
        # Some S3-compatible servers grant anonymous read by configuration instead
        # (SeaweedFS's s3.json); the bucket is usable either way.
        with contextlib.suppress(ClientError):
            self._client.put_bucket_policy(Bucket=self._bucket, Policy=json.dumps(policy))
        return True
