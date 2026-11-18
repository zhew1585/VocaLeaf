"""Read access to the S3-compatible bucket (RustFS locally, Cloudflare R2 in production)."""

from typing import Protocol

import boto3
from botocore.config import Config


class SourceStorage(Protocol):
    def get_object(self, key: str) -> bytes: ...


class S3Storage:
    def __init__(self, endpoint: str, region: str, bucket: str, access_key_id: str, secret_access_key: str):
        self._bucket = bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            # Path-style URLs work for local S3 servers and for R2 alike.
            config=Config(s3={"addressing_style": "path"}),
        )

    def get_object(self, key: str) -> bytes:
        return self._client.get_object(Bucket=self._bucket, Key=key)["Body"].read()
