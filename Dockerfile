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
# Default voice of this deployment: Mistral's preset voice "Lea", used for
# every language. A TTS_VOICE variable
# set on the host (Railway) overrides it; a client can still pick another
# voice per request.
ENV TTS_VOICE=01a151d2-8c29-766d-9ca2-30f33707cef6
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
