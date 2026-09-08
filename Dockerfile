FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && mkdir -p /app/.local && chown node:node /app/.local
USER node
ENV HOST=0.0.0.0 PORT=4312
EXPOSE 4312
CMD ["npm", "run", "dev"]
