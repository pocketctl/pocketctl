# syntax=docker/dockerfile:1
# M-7: multi-stage build. The runtime image carries only production
# dependencies + compiled dist, runs as a dedicated non-root UID, and works
# on a read-only root filesystem (state lives in Postgres; /tmp is a tmpfs
# provided by compose).

FROM node:22-alpine AS build
WORKDIR /app
ARG RELEASE_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
# Reinstall with production dependencies only for the runtime layer.
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ARG RELEASE_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV NODE_ENV=production
ENV RELEASE_VERSION=$RELEASE_VERSION
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME
# Dedicated non-root identity; fixed UID/GID for uniform volume permissions.
RUN addgroup -S -g 10001 pocketctl && adduser -S -u 10001 -G pocketctl -H pocketctl
COPY --from=build --chown=pocketctl:pocketctl /app/node_modules ./node_modules
COPY --from=build --chown=pocketctl:pocketctl /app/dist ./dist
COPY --chown=pocketctl:pocketctl package.json ./
USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/server.js"]
