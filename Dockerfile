# Build the web app (React + shadcn AI Elements + CopilotKit).
FROM node:24-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:24-slim

# Tools the agent's bash tool can use in its workspace.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git curl ca-certificates python3 jq ripgrep \
	&& rm -rf /var/lib/apt/lists/* \
	&& command -v setpriv >/dev/null # bash runs as the unprivileged agent user through it (src/confine.ts)

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# Shipped to task containers by the orchestrator (see src/orchestra.ts).
COPY runner ./runner
COPY --from=web /web/dist ./web/dist

ENV NODE_ENV=production DATA_DIR=/data
# A hard heap ceiling: the process fails fast instead of eating the host.
CMD ["node", "--max-old-space-size=768", "src/main.ts"]
