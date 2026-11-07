# Same PostgreSQL major/minor as the verified private cluster. Add extensions
# outside the live VPS; the immutable resulting image ID is the deploy input.
FROM postgres@sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5
ARG SOURCE_COMMIT=development
LABEL org.opencontainers.image.revision=${SOURCE_COMMIT}
RUN apt-get update && apt-get install -y --no-install-recommends pgbackrest postgresql-17-postgis-3 && rm -rf /var/lib/apt/lists/* \
 && postgres --version | grep -F '17.11' && pgbackrest version \
 && test -f /usr/share/postgresql/17/extension/postgis.control
