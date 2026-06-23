FROM docker.io/cloudflare/sandbox:0.12.1

USER root
RUN set -eux; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    wget -qO /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    mkdir -p -m 755 /etc/apt/sources.list.d; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    gh --version; \
    rm -rf /var/lib/apt/lists/*
RUN npm install -g opencode-ai@1.17.8

WORKDIR /opt/symphony-runner
COPY runner/run.mjs ./run.mjs
RUN chmod 0555 ./run.mjs

ENV COMMAND_TIMEOUT_MS=21600000
WORKDIR /workspace
