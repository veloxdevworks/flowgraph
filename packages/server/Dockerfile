# ARM64 image for ECS/Fargate and Amazon Bedrock AgentCore Runtime.
# Build: docker build --platform linux/arm64 -t flowgraph-server -f packages/server/Dockerfile .
# Run:   docker run --rm -p 8080:8080 -e FLOWGRAPH_AUTH_TOKEN=dev flowgraph-server

FROM node:22-bookworm-slim AS build
WORKDIR /src

# Monorepo context: build from repo root
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages

RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @veloxdevworks/flowgraph-server... build

# Optional LangChain vendor SDKs for Bedrock / OpenAI / etc.
WORKDIR /src/packages/server
RUN pnpm add \
  @langchain/aws@^1.0.0 \
  @langchain/openai@^1.0.0 \
  @langchain/anthropic@^1.0.0 \
  @langchain/google-genai@^1.0.0 \
  @langchain/ollama@^1.0.0 \
  @langchain/xai@^1.0.0 \
  || true

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    FLOWGRAPH_HOST=0.0.0.0 \
    FLOWGRAPH_PORT=8080 \
    FLOWGRAPH_GRAPH_STORE=/data/graphs

RUN mkdir -p /data/graphs

COPY --from=build /src/packages/server/dist ./dist
COPY --from=build /src/packages/server/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages ./packages

# Prefer the workspace-linked packages via NODE_PATH
ENV NODE_PATH=/app/node_modules:/app/packages/core/dist:/app/packages/spec/dist

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/bin.js"]
