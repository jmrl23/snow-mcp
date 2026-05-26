# syntax=docker/dockerfile:1.7

# ── Builder stage ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Layer-cache friendly: install deps before copying source
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive

# Compile TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN yarn build

# Produce a clean production-only node_modules in a separate folder
RUN yarn install --frozen-lockfile --non-interactive --production \
      --modules-folder /app/node_modules_prod \
    && yarn cache clean

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM gcr.io/distroless/nodejs24-debian12:nonroot

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules_prod ./node_modules
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=17880

EXPOSE 17880

# The `:nonroot` base tag already runs as the nonroot user; ENTRYPOINT is
# inherited as ["/nodejs/bin/node"], so CMD just needs the script path.
CMD ["dist/main.js"]
