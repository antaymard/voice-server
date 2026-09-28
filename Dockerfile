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
# ffmpeg/ffprobe power /v1/media/* (audio extraction, silence detection,
# re-encoding). Debian's build ships libmp3lame and libopus; fail the build
# if that ever changes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -hide_banner -encoders | grep -q libmp3lame \
 && ffmpeg -hide_banner -encoders | grep -q libopus
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
