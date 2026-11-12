# Server público de BREACH: un solo proceso Node sirve el cliente compilado y
# el WebSocket en el mismo puerto. El TLS lo termina el proveedor (Fly.io,
# Render, Railway, un proxy propio…): el contenedor habla http/ws plano en
# $PORT y el jugador entra por https/wss.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 'same-origin': el cliente se conecta al mismo host que lo sirvió
ENV VITE_BREACH_SERVER=same-origin
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# el server importa reglas compartidas de src/ (tuning, daño, colisiones)
COPY server ./server
COPY src ./src
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server/server.js"]
