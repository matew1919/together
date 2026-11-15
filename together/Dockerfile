FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --chown=node:node package.json server.mjs ice-config.mjs video-streams.mjs ./
COPY --chown=node:node public ./public
RUN mkdir /app/.data && chown node:node /app/.data
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
