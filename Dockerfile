# Multi-stage Dockerfile for BinTV
# Stage 1: Build TypeScript server and client
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency definitions
COPY package.json package-lock.json* ./

# Install all dependencies for compiling TypeScript
RUN npm ci

# Copy project files
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/

# Build server TypeScript, client TypeScript, and vendor assets
RUN npm run build

# Stage 2: Minimal Production Image
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3010

# Install curl for docker healthcheck
RUN apk add --no-cache curl

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled server code from builder
COPY --from=builder /app/dist ./dist

# Copy public static files and client builds from builder
COPY --from=builder /app/public ./public

# Setup data directory with correct permissions for non-root node user
RUN mkdir -p /app/data && chown -R node:node /app

VOLUME ["/app/data"]

USER node

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3010}/api/status || exit 1

CMD ["node", "dist/server.js"]
