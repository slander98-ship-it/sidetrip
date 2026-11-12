FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm install -D typescript @types/node && npm run build && npm prune --omit=dev
ENV NODE_ENV=production
# Run the MCP server on stdio by default; override the CMD for the watcher:
#   docker run --env-file .env sidetrip-mcp node dist/watch.js
CMD ["node", "dist/server.js"]