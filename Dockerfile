FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY packages/cli/package.json packages/cli/package.json
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server-dist ./server-dist
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "server-dist/index.js"]
