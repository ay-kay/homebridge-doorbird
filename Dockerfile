# Homebridge with homebridge-doorbird as its only plugin.
#
# Build:  docker build -t homebridge-doorbird .
# Run:    docker compose up -d   (needs host networking, see docker-compose.yml)

# Build the plugin from this repository.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY config.schema.json README.md ./
RUN npm run build && npm pack

# Runtime: Homebridge and exactly this plugin.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/homebridge
COPY --from=build /src/homebridge-doorbird-*.tgz /tmp/
RUN npm install --omit=dev --no-fund --no-audit homebridge@^2 /tmp/homebridge-doorbird-*.tgz && \
    rm /tmp/homebridge-doorbird-*.tgz && npm cache clean --force && \
    mkdir /data && chown node:node /data
COPY docker/doorbird-check.js ./

# config.json, pairing data (persist/) and cached accessories live here.
VOLUME /data
USER node
ENV TZ=Europe/Berlin

# --strict-plugin-resolution with -P: load plugins from this image only, never from anywhere else.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/homebridge/node_modules/.bin/homebridge", "-U", "/data", "-P", "/opt/homebridge/node_modules", "--strict-plugin-resolution"]
