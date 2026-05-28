FROM node:20-slim
WORKDIR /app
ENV PORT=8080
COPY package*.json ./
RUN apt-get update && apt-get install -y python3 make g++
RUN npm install --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
