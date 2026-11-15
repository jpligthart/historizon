# syntax=docker/dockerfile:1

FROM node:26-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci -w @historizon/shared -w @historizon/api
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @historizon/shared && npm run build -w @historizon/api \
  && npm prune --omit=dev -w @historizon/shared -w @historizon/api

FROM node:26-bookworm AS runner

# OCI image annotations (https://specs.opencontainers.org/image-spec/annotations/)
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="historizon-api" \
      org.opencontainers.image.description="Historizon API: timeline data (SQLite + FTS5) and cached Wikipedia extracts" \
      org.opencontainers.image.source="https://github.com/jpligthart/historizon" \
      org.opencontainers.image.url="https://github.com/jpligthart/historizon" \
      org.opencontainers.image.documentation="https://github.com/jpligthart/historizon#readme" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"
COPY LICENSE /usr/share/licenses/historizon/LICENSE

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV SQLITE_PATH=/data/historizon.sqlite
RUN mkdir -p /data && chown -R node:node /data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api ./apps/api
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@historizon/api"]
