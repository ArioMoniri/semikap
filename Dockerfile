# --- build stage --------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Install only what's needed for npm ci first; this layer caches across builds.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Now bring in the source and build the static bundle.
COPY . .
RUN npm run build

# --- runtime stage ------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5180
ENV HOST=0.0.0.0

# Copy only what's needed at runtime: built assets and the static server.
COPY --from=build /app/dist ./dist
COPY scripts/serve.mjs ./scripts/serve.mjs
COPY package.json ./package.json

# The static server uses only Node built-ins; no production deps required.
EXPOSE 5180

# A user-space user; the server doesn't need root.
RUN addgroup -S app && adduser -S -G app app
USER app

CMD ["node", "scripts/serve.mjs"]
