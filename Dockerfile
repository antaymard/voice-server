FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY client ./client
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# package.json is needed so an `npm start` launch command (e.g. a Railway
# custom start command overriding the Dockerfile CMD) can find the project.
COPY package.json ./package.json
COPY public ./public
USER node
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
