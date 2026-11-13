FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
# Listen on all interfaces inside the container; publish the port on 127.0.0.1 only (see README).
ENV HOST=0.0.0.0 PORT=3000 CONFIG=/config/config.yml
USER node
EXPOSE 3000
CMD ["node", "server.js"]
