FROM docker.io/cloudflare/sandbox:0.12.1

USER root
RUN npm install -g @openai/codex@0.141.0

WORKDIR /opt/symphony-runner
COPY runner/run.mjs ./run.mjs
RUN chmod 0555 ./run.mjs

ENV COMMAND_TIMEOUT_MS=21600000
WORKDIR /workspace
