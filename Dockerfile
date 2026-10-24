FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TUNADESK_DB=/data/tunadesk.db TUNADESK_HOST=0.0.0.0 TUNADESK_PORT=4545
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/public ./server/public
COPY --from=build /app/server/skills ./server/skills
VOLUME /data
EXPOSE 4545
CMD ["node", "server/dist/cli/index.js", "serve"]
