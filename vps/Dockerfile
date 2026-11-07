ARG NODE_IMAGE=node@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
FROM ${NODE_IMAGE} AS admin-builder
WORKDIR /build
COPY package.json package-lock.json ./
COPY vps/maps/vendor ./vps/maps/vendor
RUN npm ci --ignore-scripts
COPY admin ./admin
RUN node admin/build.mjs
FROM ${NODE_IMAGE}
ARG SOURCE_COMMIT=development
LABEL org.opencontainers.image.revision=${SOURCE_COMMIT}
ENV NODE_ENV=production TZ=UTC
WORKDIR /srv/svitlo
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY vps/maps/vendor ./vps/maps/vendor
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY app ./app
COPY pwa ./pwa
COPY server ./server
COPY supabase/migrations ./supabase/migrations
COPY vps ./vps
RUN node vps/build.mjs
COPY --from=admin-builder /build/dist/admin ./dist/admin
USER node
EXPOSE 8080
CMD ["node","--use-system-ca","vps/http.mjs"]
