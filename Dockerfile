# Defaults used only for a local build without --build-arg; the CI (release.yml /
# test-build.yml) always injects VERSION from version.txt (source of truth).
ARG GIT_COMMIT=unknown
ARG VERSION=0.0.0

FROM node:24-alpine

# Redeclare ARGs after FROM so they are available in this build stage
ARG GIT_COMMIT
ARG VERSION
LABEL git_commit=${GIT_COMMIT}
LABEL version=${VERSION}

ENV NODE_ENV=production
WORKDIR /app

# Privilege-drop helper for the entrypoint: the container starts as root,
# fixes the data volume ownership, then re-execs the CMD as `node`.
RUN apk add --no-cache su-exec

# Embedded version: ARG VERSION is injected by the CI from version.txt
# (repository root — source of truth). The short git hash stays available
# through the `git_commit` label above.
RUN echo "${VERSION}" > /app/version.txt

# Dependencies first, so this layer is cached across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./server/
COPY public/ ./public/

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Runtime data: bcrypt hash, JWT signing secret, uploaded backgrounds.
# Declared as a volume so it survives image upgrades.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
ENV PORT=3000 DATA_DIR=/data

# The container intentionally starts as root: the entrypoint chowns the
# mounted data volume to uid/gid 1000 (bind mounts are frequently owned by
# root on the host), then drops privileges via su-exec and re-execs the CMD
# as the unprivileged `node` user. Node itself never runs as root — see
# docker-entrypoint.sh and the README ("Docker").
ENTRYPOINT ["docker-entrypoint.sh"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
