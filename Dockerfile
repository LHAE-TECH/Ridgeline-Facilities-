# Ridgeline Facilities – production image
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY scripts/backup.sh ./scripts/backup.sh
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node
EXPOSE 3000
# Apply pending migrations, then start the web server (worker runs in-process unless RUN_WORKER_IN_PROCESS=false).
CMD ["sh", "-c", "node dist/migrate-cli.js && node dist/server.js"]
