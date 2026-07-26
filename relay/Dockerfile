FROM node:22-alpine
WORKDIR /app
ARG RELEASE_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV RELEASE_VERSION=$RELEASE_VERSION
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
EXPOSE 8080
CMD ["node", "dist/server.js"]
