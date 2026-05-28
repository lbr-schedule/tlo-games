FROM node:20-slim
WORKDIR /app
ENV npm_config_platform=linux-x64
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3001
ENV PORT=3001
CMD ["node", "server.js"]
