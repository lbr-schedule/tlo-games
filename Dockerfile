FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts
COPY . .
EXPOSE 3001
ENV PORT=3001
CMD ["node", "server.js"]
