FROM node:22-slim

ENV PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vite.config.ts ./
COPY src ./src

RUN corepack enable \
    && pnpm install --frozen-lockfile \
    && pnpm run build \
    && pnpm prune --prod

ENV NODE_ENV=production

EXPOSE 8080

CMD ["pnpm", "run", "start"]
