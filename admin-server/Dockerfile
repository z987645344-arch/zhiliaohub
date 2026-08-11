# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS development-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries and declares "gypfile": false, but it keeps
# binding.gyp at its package root; npm ci ignores that flag and starts an implicit
# `node-gyp rebuild`, which fails because this slim image has no Python/compiler.
# --ignore-scripts keeps the published prebuilds (bcrypt resolves its own via node-gyp-build).
RUN npm ci --ignore-scripts

FROM development-dependencies AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts && npm cache clean --force

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

# /app stays root-owned so the runtime user cannot rewrite application code.
# initializeDatabase() creates these two directories at startup, so they must exist
# and belong to node beforehand; without them the non-root process fails with EACCES.
RUN mkdir -p data lab-storage && chown node:node data lab-storage

USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
