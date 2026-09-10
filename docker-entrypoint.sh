#!/bin/sh
# Fix the data volume ownership, then drop privileges and run the CMD.
#
# The container starts as root solely to repair the mounted volume: bind
# mounts are often owned by root on the host, which made startup fail with
# `EACCES: permission denied, open '/data/config.json.tmp'` (the app runs
# unprivileged as uid/gid 1000). Once ownership is fixed, su-exec re-execs
# the CMD (`node server/index.js`) as the `node` user — Node never runs as
# root. See README ("Docker") for the full explanation.
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"   # run the CMD as uid/gid 1000, no re-exec loop
fi

# Already unprivileged (e.g. `docker run --user 1000:1000`): nothing to fix.
exec "$@"