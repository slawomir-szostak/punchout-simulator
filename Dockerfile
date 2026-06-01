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
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["node", "dist/server/cli.js"]
CMD ["--port", "8080", "--data-dir", "/data", "--no-open"]
