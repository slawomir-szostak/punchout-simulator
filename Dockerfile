# Multi-stage build: compile the SPA + server, then ship a slim runtime image
# that only carries dist/ and production dependencies.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
# --ignore-scripts: don't run dependency lifecycle scripts in the runtime image.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

# Run as the unprivileged built-in `node` user and own the data volume.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8080
VOLUME ["/data"]
# Bind all interfaces inside the container (Docker maps the published port);
# expose it safely with `-p 127.0.0.1:8080:8080` or set --token / --public-url.
ENTRYPOINT ["node", "dist/server/cli.js"]
CMD ["--port", "8080", "--data-dir", "/data", "--host", "0.0.0.0", "--no-open"]
