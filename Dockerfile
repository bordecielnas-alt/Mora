# Mora en conteneur : serveur Node + Claude Code embarqué.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/mora-entrypoint
RUN chmod +x /usr/local/bin/mora-entrypoint

# Tout ce qui doit survivre à une mise à jour vit dans /data :
#   /data/users.json         les comptes (mots de passe hachés) et les sessions
#   /data/users/<id>/        les données de chaque compte (mora.json) et sa connexion Claude (claude/)
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MORA_DATA_DIR=/data \
    CLAUDE_CONFIG_DIR=/data/claude \
    HOME=/data \
    PUID=99 \
    PGID=100

VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/mora-entrypoint"]
CMD ["node", "server.js"]
