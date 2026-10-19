#!/bin/sh
# -----------------------------------------------------------------------------
# Guard: a published Homy image MUST be a multi-platform manifest list.
#
# Why this file exists — root cause of the `:test` container restart loop:
#
#     exec /usr/local/bin/docker-entrypoint.sh: exec format error
#
# The test image used to be built with `docker build --platform linux/amd64`
# ONLY, i.e. a single-platform image. On an arm64 host (Raspberry Pi, ARM NAS,
# Apple Silicon) the kernel therefore refused to exec the amd64 `/bin/sh`
# interpreter of the entrypoint script (`ENOEXEC`), and the container restarted
# forever with an exponential back-off. Nothing in CI noticed: a single-platform
# image is a perfectly valid build on the amd64 runner. This guard turns that
# silent failure into an explicit, fail-fast CI error.
#
# How it distinguishes the two shapes:
#   * single-platform image  → the manifest has NO `manifests` array at all;
#   * multi-platform image   → `manifests[]` lists one entry per platform, plus
#     buildx attestation entries reported as `unknown/unknown` (ignored below).
#
# Usage:
#   scripts/assert-image-platforms.sh <image-ref> [platform ...]
#
#     <image-ref>  e.g. ghcr.io/owner/homy:test or ...@sha256:<digest>
#                  Inspected through `docker buildx imagetools` (registry-side
#                  read): the image is NEVER pulled, built nor pushed here.
#     [platform]   defaults to `linux/amd64 linux/arm64`
#
# Exit codes: 0 = every expected platform is present; 1 = otherwise (single
# platform image, unreadable manifest, or missing platform).
#
# Requires: docker with the buildx plugin, and either jq or python3 to parse
# the manifest JSON (both are preinstalled on GitHub's ubuntu runners).
# -----------------------------------------------------------------------------
set -eu

usage() {
  echo "usage: $0 <image-ref> [platform ...]" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
IMAGE="${1:?image reference required}"
shift

if [ "$#" -gt 0 ]; then
  EXPECTED="$*"
else
  EXPECTED="linux/amd64 linux/arm64"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "::error::docker is not available — cannot inspect '${IMAGE}'" >&2
  exit 1
fi

# JSON parser: jq on the CI runners, python3 elsewhere (no jq needed to
# reproduce this check locally).
if command -v jq >/dev/null 2>&1; then
  PARSER=jq
elif command -v python3 >/dev/null 2>&1; then
  PARSER=python3
else
  echo "::error::neither jq nor python3 is available — cannot parse the manifest of '${IMAGE}'" >&2
  exit 1
fi

# Reads the manifest JSON on stdin, prints "os/arch" once per listed platform.
list_platforms() {
  if [ "${PARSER}" = "jq" ]; then
    jq -r '(.manifests // [])[]
             | select(.platform.os != null and .platform.architecture != null)
             | select(.platform.os != "unknown")
             | "\(.platform.os)/\(.platform.architecture)"'
  else
    python3 -c '
import json, sys

data = json.load(sys.stdin)
for entry in data.get("manifests") or []:
    platform = entry.get("platform") or {}
    os_name, arch = platform.get("os"), platform.get("architecture")
    if os_name and arch and os_name != "unknown":
        print("%s/%s" % (os_name, arch))
'
  fi
}

# `--raw` prints the manifest exactly as the registry serves it (the image
# index for a multi-arch image): no pull, no platform guess, no local state.
if ! RAW="$(docker buildx imagetools inspect --raw "${IMAGE}" 2>/dev/null)"; then
  echo "::error::could not read the manifest of '${IMAGE}' (unknown reference, or not logged in?)" >&2
  exit 1
fi

# Deduplicated "os/arch" list. A single-platform image has no `manifests` key,
# so the list deliberately stays empty.
ACTUAL="$(printf '%s' "${RAW}" | list_platforms | sort -u)"

if [ -z "${ACTUAL}" ]; then
  echo "::error::'${IMAGE}' is NOT a multi-platform manifest list (single-platform image)." >&2
  echo "::error::Expected platforms: ${EXPECTED}" >&2
  echo "::error::An amd64-only image fails on arm64 hosts with 'exec format error'." >&2
  exit 1
fi

MISSING=""
for PLATFORM in ${EXPECTED}; do
  if ! printf '%s\n' "${ACTUAL}" | grep -qxF "${PLATFORM}"; then
    MISSING="${MISSING} ${PLATFORM}"
  fi
done

if [ -n "${MISSING}" ]; then
  echo "::error::'${IMAGE}' is missing platform(s):${MISSING}" >&2
  echo "::error::Found: $(printf '%s' "${ACTUAL}" | tr '\n' ' ')" >&2
  exit 1
fi

echo "Manifest of ${IMAGE}:"
printf '%s\n' "${ACTUAL}" | sed 's/^/  - /'
echo "OK: ${IMAGE} publishes: ${EXPECTED} (parsed with ${PARSER})"
