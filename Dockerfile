# ABUZ8 OS — headless server image (Linux / VPS / cloud). NO Electron, NO Chromium.
# Runs the pure-node engine (src/portable-core.js via scripts/headless.js).
#
#   docker build -t abuz8-os .
#   docker run -d -p 8900:8900 -v abuz8-data:/data --name abuz8 abuz8-os
#
# The local brain is OPTIONAL in the image (keeps it small): mount a Linux llama.cpp
# `llama-server` + a GGUF at /app/src/brain (or set ABUZ8_BRAIN_DIR), OR connect a cloud
# provider / OpenRouter. Without a brain it still serves the API, tools, OSINT, chain, etc.
FROM node:20-slim
WORKDIR /app

# Only the engine + entrypoint are needed — portable-core.js uses Node builtins only (no deps).
COPY src/portable-core.js ./src/portable-core.js
COPY src/mcp ./src/mcp
COPY scripts/headless.js ./scripts/headless.js
COPY release-manifest.json ./release-manifest.json

ENV ABUZ8_PORT=8900
ENV ABUZ8_DATA_DIR=/data
ENV NODE_ENV=production
EXPOSE 8900
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.ABUZ8_PORT||8900)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "scripts/headless.js"]
