# Multi-stage build for ECS Express Mode, matching carrieros-web's convention.
# Runs the hosted HTTP entrypoint (src/http-server.ts), not the stdio one --
# stdio only makes sense as a local subprocess of a desktop MCP client.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 mcp && adduser --system --uid 1001 mcp
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder --chown=mcp:mcp /app/dist ./dist
USER mcp
# Port 3000, not 80: the non-root user can't bind to a privileged port
# (<1024) on Linux without extra capabilities. Set the ECS/Express service's
# container port to 3000 to match.
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/http-server.js"]
