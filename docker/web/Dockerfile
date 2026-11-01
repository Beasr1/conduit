# syntax=docker/dockerfile:1
# Build context is the repo root: docker build -f docker/web/Dockerfile .

FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
# corepack runs the pnpm version pinned in package.json's packageManager.
# Node 25 and later don't ship it: this is the justfile's corepack_version.
RUN npm install --global corepack@0.36.0
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN corepack pnpm install --frozen-lockfile
COPY web/ ./
RUN corepack pnpm build

# NGINX's own non-root variant of the official image: it runs as an
# unprivileged user and listens on 8080.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
# conf.d/ loads inside the image's http {} block, in file-name order; our
# default.conf replaces the image's. snippets/ are pulled in with include.
COPY docker/web/nginx/conf.d/ /etc/nginx/conf.d/
COPY docker/web/nginx/snippets/ /etc/nginx/snippets/
COPY --from=build /web/dist /usr/share/nginx/html
EXPOSE 8080
