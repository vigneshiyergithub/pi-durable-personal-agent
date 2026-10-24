# Keep the full Node image: task verification relies on its existing build tools.
FROM node:24@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0
ARG OPENCODE_VERSION=1.19.3
RUN npm install -g --no-audit --no-fund opencode-ai@${OPENCODE_VERSION} \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}" \
    && su -s /bin/sh node -c "test \"\$(opencode --version)\" = \"${OPENCODE_VERSION}\"" \
    && npm cache clean --force
# The orchestrator supplies the runner and per-attempt credentials at launch.
