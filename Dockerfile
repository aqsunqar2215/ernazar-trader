FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

COPY package.json tsconfig.json ./
RUN pnpm install

COPY src ./src
COPY ui ./ui
RUN pnpm build

EXPOSE 8080
CMD ["node", "dist/index.js"]
