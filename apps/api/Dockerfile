# syntax=docker/dockerfile:1

FROM node:26-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci -w @historizon/shared -w @historizon/api

FROM node:26-bookworm AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY package.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @historizon/shared && npm run build -w @historizon/api \
  && npm prune --omit=dev -w @historizon/shared -w @historizon/api

FROM node:26-bookworm AS runner
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
