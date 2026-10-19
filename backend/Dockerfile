# CodeLumen backend: Node API + C++/Java/Python toolchains + hardened sandbox.
FROM node:24-bookworm-slim

# g++ / javac / python3 for user programs.
# util-linux provides prlimit and setpriv, used to drop privileges and apply
# resource limits to every submitted program. tini reaps zombie processes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ openjdk-17-jdk-headless python3 util-linux tini \
 && rm -rf /var/lib/apt/lists/*

# Unprivileged user that runs submitted code. It owns nothing outside its own
# per-run job directory.
RUN groupadd --gid 10001 sandbox \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sandbox \
 && mkdir -p /sandbox && chmod 0711 /sandbox

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

# The sandbox user must not be able to read the app source or its .env.
RUN chmod -R go-rwx /app

ENV NODE_ENV=production \
    SANDBOX_MODE=hardened \
    PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The API process runs as root *inside the container* only so it can drop
# each submitted program to uid 10001 (see src/executeCode.js). Pair this with
# the restricted capabilities in docker-compose.yml.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
