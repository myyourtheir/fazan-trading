FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM nginx:alpine
ENV BACKEND_UPSTREAM=backend:3000 BACKEND_RESOLVER=127.0.0.11 NGINX_ENVSUBST_FILTER="^(BACKEND_UPSTREAM|BACKEND_RESOLVER)$"
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
