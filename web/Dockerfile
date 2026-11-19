# Build context: repository root (npm workspaces share one lockfile).
FROM public.ecr.aws/docker/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci -w web
COPY web web
# The one API module the web imports at runtime (dependency-free; web/src/cards/MakeCard.tsx).
COPY api/src/cards/target.ts api/src/cards/target.ts
RUN npm run build -w web

FROM public.ecr.aws/docker/library/nginx:1.27-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
