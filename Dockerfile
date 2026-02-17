# Dockerfile (runtime non-root)
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
  && npm cache clean --force

COPY . .

# Dossiers utilises par l'application
RUN mkdir -p /var/data/uploads /usr/src/app/tmp /usr/src/app/jobs \
  && chown -R node:node /usr/src/app /var/data/uploads

USER node

EXPOSE 3000
CMD ["node","server.js"]
