# a4a (agenda): one image with the API, the MCP endpoint and the web UI.
# Build:  docker build -t a4a .
# Run:    docker compose up   (Postgres + a4a; see docker-compose.yml)

FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/mcp-bridge/package.json packages/mcp-bridge/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @a4a/web build \
 && pnpm --filter @a4a/server build \
 && pnpm --filter @a4a/server deploy --prod --legacy /out \
 && cp -r packages/server/dist packages/server/drizzle /out/ \
 && cp -r apps/web/dist /out/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/web \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
