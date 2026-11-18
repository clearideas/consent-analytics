# The standalone collector. Build from the repository root:
#   docker build -f collector/Dockerfile -t consent-analytics-collector .
# Configure with environment variables (collector/README.md). Defaults: SQLite in /data.
FROM node:24-alpine AS build
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --ignore-scripts --no-audit --no-fund
COPY spec/ spec/
COPY server/ server/
RUN cd server && npm run build
COPY collector/package.json collector/package-lock.json collector/
RUN cd collector && npm ci --ignore-scripts --no-audit --no-fund
COPY collector/ collector/
RUN cd collector && npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
# The server library has no dependencies: its manifest, dist and notices are all it needs.
COPY --from=build /app/server/package.json /app/server/LICENSE /app/server/THIRD_PARTY_NOTICES.md server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/collector/package.json /app/collector/LICENSE collector/
COPY --from=build /app/collector/dist collector/dist
COPY --from=build /app/collector/node_modules collector/node_modules
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/collector
ENV NODE_ENV=production \
    PORT=8787 \
    STORE=sqlite \
    DATABASE_PATH=/data/analytics.db
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/cli.js"]
