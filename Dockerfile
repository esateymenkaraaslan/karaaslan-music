FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js README.md ./
COPY public ./public
RUN mkdir -p /app/uploads && chown -R node:node /app

USER node
EXPOSE 3000
VOLUME ["/app/uploads"]
CMD ["node", "server.js"]
