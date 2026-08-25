# syntax=docker/dockerfile:1
# Multi-stage Node 22 build for the pocketctl-memory service. The runtime
# image carries only dist/ and production dependencies, runs as the
# unprivileged uid 10002 and keeps root-owned, read-only code.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Build needs the TypeScript compiler; runtime deps are pruned separately.
RUN npm ci --legacy-peer-deps
COPY tsconfig.json ./
COPY src ./src
RUN ./node_modules/.bin/tsc

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 10002 memory && adduser -D -u 10002 -G memory memory
COPY --from=deps --chown=root:root /app/package.json ./package.json
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
USER 10002
# api-main for the API service; override to dist/worker-main.js for workers.
CMD ["node", "dist/api-main.js"]
