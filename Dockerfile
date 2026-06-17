FROM node:20-alpine

WORKDIR /app

# Instalar dependências primeiro (cache layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar código (inclui src/config/restaurante.js)
COPY src/ ./src/

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "src/index.js"]
