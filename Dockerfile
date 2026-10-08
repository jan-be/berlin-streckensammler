# Build: tests, then one bundle (server + the React app Bun bundles from index.html)
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY data ./data
COPY src ./src
RUN bun test && bun run build

# Run: only the bundle. The station data is inside server.js; the database
# lives in /data (a volume).
FROM oven/bun:1-slim
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/app.db
# the bundle finds its client files relative to the working directory
WORKDIR /app
COPY --from=build /app/dist ./
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 3000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD bun -e "fetch('http://localhost:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "server.js"]
