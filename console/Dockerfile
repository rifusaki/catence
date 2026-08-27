# Build from the repository root:
# docker build -f console/Dockerfile -t catence-console .
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    UV_LINK_MODE=copy \
    CATENCE_HOME=/data

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && install -m 755 /root/.local/bin/uv /usr/local/bin/uv

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY . .
RUN npm run build \
    && npm install --global --ignore-scripts . \
    && uv sync --project console --upgrade --no-dev

RUN useradd --create-home --uid 10001 catence \
    && mkdir -p /data \
    && chown -R catence:catence /app /data

USER catence
WORKDIR /app
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/bin/sh", "-c", "catence-data --home /data migrate --all 2>/dev/null || npx --yes catence@$(node -p \"require('/app/package.json').version\") --home /data migrate --all 2>/dev/null || true; exec uv run --project /app/console catence-console serve --ui-host 0.0.0.0 --mcp-host 127.0.0.1"]
