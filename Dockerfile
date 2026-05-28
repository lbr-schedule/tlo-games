FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN apt-get update && apt-get install -y python3 make g++
RUN npm install --omit=dev
COPY . .
EXPOSE 3001
ENV PORT=3001
CMD ["node", "server.js"]
