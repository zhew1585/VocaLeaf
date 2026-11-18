# Build context: repository root (npm workspaces share one lockfile).
FROM public.ecr.aws/docker/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci -w api
COPY api api
RUN npm run build -w api

FROM public.ecr.aws/docker/library/node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci -w api --omit=dev && npm cache clean --force
COPY --from=build /app/api/dist api/dist
COPY api/drizzle api/drizzle
WORKDIR /app/api
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
