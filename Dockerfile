FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# Le conteneur tourne avec un rootfs en lecture seule : rien n'est écrit sur
# disque, tout l'état vit dans la configuration Gladys.
USER node

CMD ["node", "src/index.js"]
