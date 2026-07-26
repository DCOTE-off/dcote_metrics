FROM node:24.18.0-bookworm-slim AS base
WORKDIR /usr/local/app

RUN addgroup --gid 1001 nodejs && \
    adduser --uid 1001 --gid 1001 --disabled-password --gecos "" nodejs && \
    mkdir -p /var/lib/dcote-metrics && \
    chown -R nodejs:nodejs /usr/local/app /var/lib/dcote-metrics

#Development
FROM base AS development
ENV NODE_ENV=development

COPY package*.json ./

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund && \
    npm cache clean --force

COPY --chown=nodejs:nodejs . .

EXPOSE 3000

USER nodejs

CMD ["npm","run","dev"]

FROM base AS production

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=256 --no-warnings" \
    NPM_CONFIG_LOGLEVEL=silent

COPY package*.json ./

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev && \
    npm cache clean --force

COPY --chown=nodejs:nodejs src ./src
COPY --chown=nodejs:nodejs public ./public
COPY --chown=nodejs:nodejs database ./database

EXPOSE 3000

USER nodejs

CMD ["npm","run","start"]
