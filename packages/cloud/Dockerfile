# 构建上下文为仓库根目录：docker build -f packages/cloud/Dockerfile .
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
# 大陆机房构建时可传镜像地址（留空则用官方源），见 docs/tencent-deploy.md
ARG NPM_REGISTRY=
ARG PRISMA_ENGINES_MIRROR=
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/cloud/package.json packages/cloud/package.json
RUN if [ -n "$NPM_REGISTRY" ]; then export COREPACK_NPM_REGISTRY="$NPM_REGISTRY" npm_config_registry="$NPM_REGISTRY"; fi; \
    if [ -n "$PRISMA_ENGINES_MIRROR" ]; then export PRISMA_ENGINES_MIRROR; fi; \
    pnpm install --frozen-lockfile --filter @talekiln/cloud...
COPY packages/cloud packages/cloud
WORKDIR /repo/packages/cloud
RUN if [ -n "$PRISMA_ENGINES_MIRROR" ]; then export PRISMA_ENGINES_MIRROR; fi; \
    pnpm exec prisma generate && pnpm exec tsc -p tsconfig.build.json
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD curl -fs http://localhost:3000/health || exit 1
# 启动前应用已检入的迁移
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main.js"]
