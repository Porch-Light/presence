FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# Statuses and delegates are JSON files under /data: mount a volume there or they vanish with the container.
ENV PORT=3010 PRESENCE_DATA=/data
VOLUME /data
EXPOSE 3010
USER node
CMD ["node", "src/server.js"]
