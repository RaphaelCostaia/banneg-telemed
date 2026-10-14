# Banneg Telemedicina — imagem para EasyPanel / VPS
FROM node:24-alpine

WORKDIR /app

# Dependências (cache de camada)
COPY package*.json ./
RUN npm ci --omit=dev

# Código
COPY . .

# Dados (SQLite) — monte um VOLUME do EasyPanel em /app/data para persistir entre deploys
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=3000
EXPOSE 3000

# As variáveis de ambiente vêm do painel do EasyPanel (não usa --env-file aqui)
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
