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
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
