# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS development-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM development-dependencies AS production-dependencies
RUN npm prune --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    SCHEMA_PATH=/app/schema/schema.sql
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node data/schema.sql ./schema/schema.sql
COPY --chown=node:node content/works/.gitkeep ./content/works/.gitkeep
COPY --chown=node:node content/notes/.gitkeep ./content/notes/.gitkeep
COPY --chown=node:node uploads/.gitkeep ./uploads/.gitkeep
COPY --chown=node:node backups/.gitkeep ./backups/.gitkeep

USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
