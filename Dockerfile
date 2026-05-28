FROM node:20-slim
WORKDIR /app
RUN npm install -g serve
COPY . .
EXPOSE 3001
CMD ["serve", "-l", "3001", "."]
