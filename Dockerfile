FROM node:24-bookworm-slim AS base
WORKDIR /usr/local/app

RUN addgroup --gid 1001 nodejs && \
    adduser --uid 1001 --gid 1001 --disabled-password --gecos "" nodejs && \
    chown -R nodejs:nodejs /usr/local/app

#Development
FROM base AS development
ENV NODE_ENV=development

COPY package*.json ./

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund && \
    npm cache clean --force

COPY . .

EXPOSE 3000

CMD ["npm","run","start"]

FROM base AS production

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=256 --no-warnings" \
    NPM_CONFIG_LOGLEVEL=silent


RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev && \
    npm cache clean --force

RUN chown -R nodejs:nodejs /usr/local/app
USER nodejs

CMD ["npm","run","start"]