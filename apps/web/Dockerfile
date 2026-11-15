# syntax=docker/dockerfile:1

FROM node:26-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci -w @historizon/shared -w @historizon/web
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @historizon/shared && npm run build -w @historizon/web

FROM nginx:1.30.6-alpine

# OCI image annotations (https://specs.opencontainers.org/image-spec/annotations/)
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="historizon-web" \
      org.opencontainers.image.description="Historizon web: zoomable timeline of what happened at the same time" \
      org.opencontainers.image.source="https://github.com/jpligthart/historizon" \
      org.opencontainers.image.url="https://github.com/jpligthart/historizon" \
      org.opencontainers.image.documentation="https://github.com/jpligthart/historizon#readme" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"
COPY LICENSE /usr/share/licenses/historizon/LICENSE

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
