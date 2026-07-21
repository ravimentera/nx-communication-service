FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
COPY .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS production
RUN apk add --no-cache curl
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY package*.json ./
COPY .npmrc ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY packs ./packs
COPY migrations ./migrations
RUN mkdir -p logs uploads && chown -R app:app /app
USER app
ENV NODE_ENV=production PORT=5007
EXPOSE 5007
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:5007/health || exit 1
CMD ["node", "dist/index.js"]
