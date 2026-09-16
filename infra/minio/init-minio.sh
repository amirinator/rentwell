#!/bin/sh
# Creates the private import bucket. Import files must never be publicly readable;
# the API hands out short-lived signed URLs after an authorization check instead.
set -eu

BUCKET="${S3_BUCKET:-rentwell-imports}"

echo "waiting for minio..."
until mc alias set local http://minio:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null 2>&1; do
  sleep 1
done

if mc ls "local/${BUCKET}" >/dev/null 2>&1; then
  echo "bucket ${BUCKET} already exists"
else
  mc mb "local/${BUCKET}"
  echo "created bucket ${BUCKET}"
fi

# Explicitly remove any anonymous access policy.
mc anonymous set none "local/${BUCKET}" || true
mc version enable "local/${BUCKET}" || true

echo "minio init complete"
