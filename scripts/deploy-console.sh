#!/usr/bin/env bash
#
# deploy-console.sh - Deploy the currently published Catence Console (stable or
# beta) on a server using Docker. It resolves the latest version from the npm and
# PyPI registries, writes a self-contained Docker Compose project, builds the
# Console image, and starts it behind its password-protected Chainlit login.
#
# Intended to run under WSL or Git Bash on Windows (or any Linux/macOS host) with
# Docker Desktop / Docker Engine (Linux containers) and `docker compose` available.
#
# Usage:
#   ./deploy-console.sh [stable|beta] [options]
#
# Examples:
#   ./deploy-console.sh                       # latest stable
#   ./deploy-console.sh beta                  # latest beta
#   ./deploy-console.sh beta --generate-secrets  # prompt for a password hash
#   ./deploy-console.sh --port 8080 --bind 0.0.0.0
#   ./deploy-console.sh --mcp-bind 0.0.0.0     # expose MCP on Tailscale interface
#   ./deploy-console.sh --home /mnt/d/catence-data --no-build
#
# The script writes the complete scaffold (Dockerfile, docker-compose.yml, and a
# .env with placeholders), seeds a starter Console configuration into the data
# volume, and builds the image without needing any secrets. Add the Console
# password hash and one model-provider key to .env afterwards, then run
# `docker compose up -d` or re-run this script. Pass --generate-secrets to be
# prompted for the password and have the hash written for you.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults (override with environment variables or command-line flags)
# ---------------------------------------------------------------------------
CHANNEL="${CATENCE_CHANNEL:-stable}"            # stable | beta
PORT="${CATENCE_CONSOLE_PORT:-8000}"
BIND="${CATENCE_BIND_ADDRESS:-127.0.0.1}"
MCP_BIND="${CATENCE_MCP_BIND:-}"
MCP_PORT="${CATENCE_MCP_PORT:-8787}"
DEPLOY_DIR="${CATENCE_DEPLOY_DIR:-catence-deploy}"
USERNAME="${CATENCE_CONSOLE_USERNAME:-}"
NPM_VERSION="${CATENCE_NPM_VERSION:-}"           # optional pin
CONSOLE_VERSION="${CATENCE_CONSOLE_VERSION:-}"   # optional pin
PASSWORD_HASH="${CATENCE_CONSOLE_PASSWORD_HASH:-}"
AUTH_SECRET="${CHAINLIT_AUTH_SECRET:-}"
DATA_HOME="${CATENCE_DATA_HOME:-}"               # optional bind-mount host path
DATA_VOLUME="${CATENCE_DATA_VOLUME:-}"           # optional named-volume override
SKIP_BUILD="${CATENCE_SKIP_BUILD:-0}"
PULL="${CATENCE_PULL:-1}"
GENERATE_SECRETS="${CATENCE_GENERATE_SECRETS:-0}"
DRY_RUN="${CATENCE_DRY_RUN:-0}"
ENV_FILE="${CATENCE_ENV_FILE:-}"                 # optional existing env to source

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

usage() {
  if [ -f "$0" ] && [ -r "$0" ]; then
    sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  else
    cat <<'EOF'
Usage: curl -fsSL <raw-url> | bash -s [stable|beta] [options]

  stable|beta           channel (default: stable)
  --generate-secrets    prompt for a Console password and write its bcrypt hash
  --port N              host port to publish (default: 8000)
  --bind ADDR           bind address for Console UI (default: 127.0.0.1)
  --mcp-bind ADDR       bind address for MCP server (default: 127.0.0.1; use 0.0.0.0 for Tailscale)
  --dir DIR             deployment directory (default: ./catence-deploy)
  --home DIR            bind-mount DIR as the Catence data volume
  --volume NAME         named volume for Catence data (default: catence[-channel]-data)
  --username NAME       Console login name (default: coach)
  --password-hash HASH  provide a bcrypt hash instead of generating one
  --auth-secret SECRET  provide a Chainlit signing secret
  --npm-version V       pin the npm catence version
  --console-version V   pin the catence-console version
  --env-file FILE       source an existing environment file first
  --no-build            reuse the existing image
  --no-pull             skip --pull on build
  --dry-run             write the scaffold without building
  -h, --help            show this help
EOF
  fi
  exit 0
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required. $2"
}

dotenv_get() { # key file -> literal value (no shell expansion of `$`)
  grep -E "^$1=" "$2" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    stable|beta) CHANNEL="$1" ;;
    --channel)    shift; CHANNEL="$1" ;;
    --port)       shift; PORT="$1" ;;
    --bind)       shift; BIND="$1" ;;
    --mcp-bind)   shift; MCP_BIND="$1" ;;
    --dir)        shift; DEPLOY_DIR="$1" ;;
    --username)   shift; USERNAME="$1" ;;
    --npm-version)    shift; NPM_VERSION="$1" ;;
    --console-version) shift; CONSOLE_VERSION="$1" ;;
    --password-hash)   shift; PASSWORD_HASH="$1" ;;
    --auth-secret)     shift; AUTH_SECRET="$1" ;;
    --home)       shift; DATA_HOME="$1" ;;
    --volume)     shift; DATA_VOLUME="$1" ;;
    --env-file)   shift; ENV_FILE="$1" ;;
    --no-build)   SKIP_BUILD=1 ;;
    --no-pull)    PULL=0 ;;
    --generate-secrets) GENERATE_SECRETS=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    -h|--help)    usage ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

case "$CHANNEL" in
  stable|beta) ;;
  *) die "CHANNEL must be 'stable' or 'beta' (got '$CHANNEL')" ;;
esac

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
need_cmd docker "Install Docker Desktop (Linux containers) or Docker Engine."
need_cmd curl "Install curl."

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "docker compose (or docker-compose) is required."
fi

if command -v python3 >/dev/null 2>&1; then JSON_PY=python3
elif command -v python >/dev/null 2>&1; then JSON_PY=python
else JSON_PY=""; fi
if command -v node >/dev/null 2>&1; then JSON_NODE=node; else JSON_NODE=""; fi

# ---------------------------------------------------------------------------
# Load optional environment values (provider keys, pre-set secrets)
# ---------------------------------------------------------------------------
if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || die "--env-file '$ENV_FILE' not found"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# Merge sourced/flag values, then preserve anything a user already saved in the
# deploy directory's .env. The .env is read literally (never `source`d) so a
# bcrypt hash's `$` characters are not expanded.
USERNAME="${USERNAME:-${CATENCE_CONSOLE_USERNAME:-}}"
PASSWORD_HASH="${PASSWORD_HASH:-${CATENCE_CONSOLE_PASSWORD_HASH:-}}"
AUTH_SECRET="${AUTH_SECRET:-${CHAINLIT_AUTH_SECRET:-}}"

if [ -f "$DEPLOY_DIR/.env" ]; then
  [ -n "$USERNAME" ]          || USERNAME="$(dotenv_get CATENCE_CONSOLE_USERNAME "$DEPLOY_DIR/.env")"
  [ -n "$PASSWORD_HASH" ]      || PASSWORD_HASH="$(dotenv_get CATENCE_CONSOLE_PASSWORD_HASH "$DEPLOY_DIR/.env")"
  [ -n "$AUTH_SECRET" ]        || AUTH_SECRET="$(dotenv_get CHAINLIT_AUTH_SECRET "$DEPLOY_DIR/.env")"
  [ -n "${OPENAI_API_KEY:-}" ]    || OPENAI_API_KEY="$(dotenv_get OPENAI_API_KEY "$DEPLOY_DIR/.env")"
  [ -n "${OPENAI_API_BASE:-}" ]   || OPENAI_API_BASE="$(dotenv_get OPENAI_API_BASE "$DEPLOY_DIR/.env")"
  [ -n "${ANTHROPIC_API_KEY:-}" ] || ANTHROPIC_API_KEY="$(dotenv_get ANTHROPIC_API_KEY "$DEPLOY_DIR/.env")"
  [ -n "${OPENCODE_GO_API_KEY:-}" ]          || OPENCODE_GO_API_KEY="$(dotenv_get OPENCODE_GO_API_KEY "$DEPLOY_DIR/.env")"
  [ -n "${OPENCODE_GO_API_BASE:-}" ]         || OPENCODE_GO_API_BASE="$(dotenv_get OPENCODE_GO_API_BASE "$DEPLOY_DIR/.env")"
  [ -n "${OPENCODE_GO_MESSAGES_API_BASE:-}" ] || OPENCODE_GO_MESSAGES_API_BASE="$(dotenv_get OPENCODE_GO_MESSAGES_API_BASE "$DEPLOY_DIR/.env")"
  [ -n "${MCP_BIND:-}" ]            || MCP_BIND="$(dotenv_get CATENCE_MCP_BIND "$DEPLOY_DIR/.env")"
fi

USERNAME="${USERNAME:-coach}"

# ---------------------------------------------------------------------------
# Registry JSON helpers
# ---------------------------------------------------------------------------
registry_json() { # url python-code node-code
  local url="$1" pycode="$2" nodecode="$3" body
  body="$(curl -fsSL "$url")" || die "cannot reach $url"
  if [ -n "$JSON_PY" ]; then
    printf '%s' "$body" | "$JSON_PY" -c "$pycode"
  elif [ -n "$JSON_NODE" ]; then
    printf '%s' "$body" | "$JSON_NODE" -e "$nodecode"
  else
    die "python3 or node is required to parse registry responses."
  fi
}

semver_to_pep440() {
  local v="$1"
  case "$v" in
    *-beta.*) printf '%s' "${v/-beta./b}" ;;
    *-*)      die "unsupported npm prerelease '$v'; expected X.Y.Z or X.Y.Z-beta.N" ;;
    *)        printf '%s' "$v" ;;
  esac
}

pypi_has_version() { # package version -> 1 | 0
  registry_json "https://pypi.org/pypi/$1/json" \
    "import sys,json;print('1' if '$2' in json.load(sys.stdin).get('releases',{}) else '0')" \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(('$2' in (JSON.parse(s).releases||{}))?'1':'0'))"
}

# ---------------------------------------------------------------------------
# Resolve versions from the public registries
# ---------------------------------------------------------------------------
npm_tag="latest"
[ "$CHANNEL" = "beta" ] && npm_tag="beta"

if [ -z "$NPM_VERSION" ]; then
  info "Resolving latest $CHANNEL catence version from the npm registry..."
  NPM_VERSION="$(registry_json "https://registry.npmjs.org/catence" \
    "import sys,json;print(json.load(sys.stdin).get('dist-tags',{}).get('$npm_tag',''))" \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(((JSON.parse(s)||{}).['dist-tags']||{})['$npm_tag']||''))")"
  [ -n "$NPM_VERSION" ] || die "npm registry has no '$npm_tag' dist-tag for catence"
fi

if [ "$CHANNEL" = "beta" ]; then
  case "$NPM_VERSION" in
    *-beta.*) ;;
    *) die "beta channel expected an npm 'X.Y.Z-beta.N' version (got '$NPM_VERSION')" ;;
  esac
else
  case "$NPM_VERSION" in
    *-*) die "stable channel expected a plain npm 'X.Y.Z' version (got '$NPM_VERSION')" ;;
  esac
fi

if [ -z "$CONSOLE_VERSION" ]; then
  CONSOLE_VERSION="$(semver_to_pep440 "$NPM_VERSION")"
fi

info "catence (npm):       $NPM_VERSION"
info "catence-console:     $CONSOLE_VERSION"

if [ "$(pypi_has_version catence-console "$CONSOLE_VERSION")" != "1" ]; then
  die "catence-console==$CONSOLE_VERSION is not published on PyPI"
fi

# ---------------------------------------------------------------------------
# Resolve project identity, image, and data volume
# ---------------------------------------------------------------------------
if [ "$CHANNEL" = "stable" ]; then
  PROJECT="catence"
  DEFAULT_VOLUME="catence-data"
else
  PROJECT="catence-$CHANNEL"
  DEFAULT_VOLUME="catence-$CHANNEL-data"
fi
[ -n "$DATA_VOLUME" ] || DATA_VOLUME="$DEFAULT_VOLUME"
IMAGE_NAME="catence-console:${CHANNEL}-${NPM_VERSION}"

# ---------------------------------------------------------------------------
# Generate the signing secret when missing
# ---------------------------------------------------------------------------
if [ -z "$AUTH_SECRET" ]; then
  if command -v openssl >/dev/null 2>&1; then
    AUTH_SECRET="$(openssl rand -hex 32)"
  elif [ -r /dev/urandom ]; then
    AUTH_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  else
    AUTH_SECRET="$(printf '%s' "${RANDOM}${RANDOM}${RANDOM}$(date +%s%N)$$" | sha256sum | cut -d' ' -f1)"
  fi
  info "Generated CHAINLIT_AUTH_SECRET."
fi

# ---------------------------------------------------------------------------
# Write the deployment directory
# ---------------------------------------------------------------------------
mkdir -p "$DEPLOY_DIR"

write_dockerfile() {
  cat > "$DEPLOY_DIR/Dockerfile" <<'EOF'
FROM node:22-bookworm-slim

ARG CATENCE_NPM_VERSION
ARG CATENCE_CONSOLE_VERSION
ARG CATENCE_MCP_BIND
ENV DEBIAN_FRONTEND=noninteractive \
    UV_LINK_MODE=copy \
    UV_PYTHON_INSTALL_DIR=/usr/local/uv/python \
    CATENCE_HOME=/data

RUN test -n "$CATENCE_NPM_VERSION" \
    && test -n "$CATENCE_CONSOLE_VERSION" \
    && test -n "$CATENCE_MCP_BIND" \
    && apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && install -m 755 /root/.local/bin/uv /usr/local/bin/uv

RUN npm install --global "catence@${CATENCE_NPM_VERSION}" \
    && uv python install 3.12 \
    && uv venv /opt/catence-console --python 3.12 \
    && uv pip install --python /opt/catence-console/bin/python "catence-console==${CATENCE_CONSOLE_VERSION}"

RUN useradd --create-home --uid 10001 catence \
    && mkdir -p /data \
    && chown -R catence:catence /data /opt/catence-console

USER catence
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8000 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/bin/sh", "-c", "/opt/catence-console/bin/catence-console serve --ui-host 0.0.0.0 --mcp-host \"${CATENCE_MCP_BIND:-127.0.0.1}\""]
EOF
}

write_compose() {
  local volume_spec volumes_block=""
  if [ -n "$DATA_HOME" ]; then
    volume_spec="$DATA_HOME"
  else
    volume_spec="$DATA_VOLUME"
    volumes_block="volumes:
  ${DATA_VOLUME}:"
  fi

  cat > "$DEPLOY_DIR/docker-compose.yml" <<EOF
name: ${PROJECT}

services:
  console:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        CATENCE_NPM_VERSION: "${NPM_VERSION}"
        CATENCE_CONSOLE_VERSION: "${CONSOLE_VERSION}"
        CATENCE_MCP_BIND: "\${CATENCE_MCP_BIND:-${MCP_BIND}}"
    image: ${IMAGE_NAME}
    restart: unless-stopped
    ports:
      - "${BIND}:${PORT}:8000"
      - "\${CATENCE_MCP_BIND:-${MCP_BIND}}:${MCP_PORT}:8787"
    environment:
      CATENCE_HOME: /data
      CATENCE_MCP_BIND: "\${CATENCE_MCP_BIND:-${MCP_BIND}}"
      CATENCE_CONSOLE_USERNAME: "\${CATENCE_CONSOLE_USERNAME:-}"
      CATENCE_CONSOLE_PASSWORD_HASH: "\${CATENCE_CONSOLE_PASSWORD_HASH:-}"
      CHAINLIT_AUTH_SECRET: "\${CHAINLIT_AUTH_SECRET:-}"
      OPENAI_API_KEY: "\${OPENAI_API_KEY:-}"
      OPENAI_API_BASE: "\${OPENAI_API_BASE:-}"
      ANTHROPIC_API_KEY: "\${ANTHROPIC_API_KEY:-}"
      OPENCODE_GO_API_KEY: "\${OPENCODE_GO_API_KEY:-}"
      OPENCODE_GO_API_BASE: "\${OPENCODE_GO_API_BASE:-}"
      OPENCODE_GO_MESSAGES_API_BASE: "\${OPENCODE_GO_MESSAGES_API_BASE:-}"
    volumes:
      - ${volume_spec}:/data

${volumes_block}
EOF
}

write_env() {
  umask 077
  cat > "$DEPLOY_DIR/.env" <<EOF
# Catence Console deployment environment (managed by deploy-console.sh)
CATENCE_NPM_VERSION=${NPM_VERSION}
CATENCE_CONSOLE_VERSION=${CONSOLE_VERSION}
CATENCE_CONSOLE_USERNAME=${USERNAME}
CATENCE_CONSOLE_PASSWORD_HASH=${PASSWORD_HASH}
CHAINLIT_AUTH_SECRET=${AUTH_SECRET}
CATENCE_MCP_BIND=${MCP_BIND}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
OPENAI_API_BASE=${OPENAI_API_BASE:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OPENCODE_GO_API_KEY=${OPENCODE_GO_API_KEY:-}
OPENCODE_GO_API_BASE=${OPENCODE_GO_API_BASE:-https://opencode.ai/zen/go/v1}
OPENCODE_GO_MESSAGES_API_BASE=${OPENCODE_GO_MESSAGES_API_BASE:-https://opencode.ai/zen/go}
EOF
}

write_hash_helper() {
  cat > "$DEPLOY_DIR/hash-password.sh" <<'EOF'
#!/bin/sh
# Generate the bcrypt hash for CATENCE_CONSOLE_PASSWORD_HASH in .env.
# The password is prompted for on the terminal and never echoed.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec docker compose -f "$DIR/docker-compose.yml" --env-file "$DIR/.env" run --rm \
  --entrypoint /opt/catence-console/bin/catence-console console auth hash-password
EOF
  chmod +x "$DEPLOY_DIR/hash-password.sh"
}

write_doctor_helper() {
  cat > "$DEPLOY_DIR/doctor.sh" <<'EOF'
#!/bin/sh
# Run catence-console doctor inside the running container: the container's own
# loopback hosts the live MCP server, and the provider keys from .env are in
# its environment. (A `docker compose run` container has a separate loopback.)
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec docker compose -f "$DIR/docker-compose.yml" --env-file "$DIR/.env" exec console \
  /opt/catence-console/bin/catence-console doctor --home /data --mcp-url http://127.0.0.1:8787/mcp
EOF
  chmod +x "$DEPLOY_DIR/doctor.sh"
}

write_sync_helper() {
  cat > "$DEPLOY_DIR/sync.sh" <<'EOF'
#!/bin/sh
# Run catence-data inside the running console container: the container's own
# environment already holds the provider secrets, so incremental sync, full
# backfill, coverage status, live progress, and athlete listing need no extra
# credentials. (A `docker compose run` container would need the secrets piped
# in again.)
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ATHLETE="${CATENCE_ATHLETE:-}"

print_help() {
  cat <<'USAGE'
usage: sync.sh [--athlete <id>] <command> [args...]

commands:
  sync                   incremental sync of all providers
  backfill <date>        full backfill from an ISO date (for example 2026-01-01)
  progress               live progress for active sync runs (--watch to follow)
  status                 per-provider coverage and errors
  athletes               list athlete IDs in the catalog

options:
  --athlete <id>         athlete ID (default: $CATENCE_ATHLETE)
  --detach               run sync/backfill in the background and return
  -h, --help             show this help

examples:
  ./sync.sh --athlete martina sync
  ./sync.sh --athlete martina backfill 2026-01-01
  ./sync.sh --athlete martina progress --watch
  ./sync.sh --athlete martina sync --detach
  ./sync.sh --athlete martina status
  ./sync.sh athletes
USAGE
}

usage() {
  print_help >&2
  exit 1
}

if [ "${1:-}" = "--athlete" ]; then
  ATHLETE="$2"
  shift 2
elif [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  print_help
  exit 0
fi

# Strip --detach from the argument list (any position) and remember it; the
# container command itself must never see it.
detach=""
_rest=""
for _arg in "$@"; do
  if [ "$_arg" = "--detach" ]; then
    detach="-d"
  else
    _rest="$_rest $_arg"
  fi
done
set -- $_rest

command="${1:-}"
[ -n "$command" ] || usage
[ "$command" = "athletes" ] || [ -n "$ATHLETE" ] || usage

case "$command" in
  sync)
    shift
    exec docker compose -f "$DIR/docker-compose.yml" --env-file "$DIR/.env" exec $detach console \
      catence-data sync --athlete "$ATHLETE" --provider all --home /data "$@"
    ;;
  backfill)
    shift
    from="${1:-}"
    case "$from" in
      ""|--*)
        echo "error: backfill needs an ISO from date (for example: ./sync.sh --athlete martina backfill 2026-01-01)" >&2
        exit 1
        ;;
    esac
    shift
    exec docker compose -f "$DIR/docker-compose.yml" --env-file "$DIR/.env" exec $detach console \
      catence-data backfill --athlete "$ATHLETE" --from "$from" --home /data "$@"
    ;;
  progress)
    shift
    exec docker compose -f "$DIR/docker-compose.yml" --env-file "$DIR/.env" exec console \
      catence-data progress --athlete "$ATHLETE" --home /data "$@"
    ;;
  status)
    shift
    exec docker compose -f "$DIR/docker-compose.yml" --env-file "$DIR/.env" exec console \
      catence-data status --athlete "$ATHLETE" --home /data "$@"
    ;;
  athletes)
    shift
    exec docker compose -f "$DIR/docker-compose.yml" --env-file "$DIR/.env" exec console \
      catence-data athlete list --home /data "$@"
    ;;
  *) usage ;;
esac
EOF
  chmod +x "$DEPLOY_DIR/sync.sh"
}

write_dockerfile
write_compose
write_env
write_hash_helper
write_doctor_helper
write_sync_helper

# ---------------------------------------------------------------------------
# Dry run stops after writing the scaffold
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  info "Dry run complete. Wrote $DEPLOY_DIR/"
  info "Would deploy: project=$PROJECT image=$IMAGE_NAME channel=$CHANNEL"
  exit 0
fi

# ---------------------------------------------------------------------------
# Build the image (no secrets required; versions are baked into the build args)
# ---------------------------------------------------------------------------
if [ "$SKIP_BUILD" = "1" ]; then
  info "Skipping build (using existing image $IMAGE_NAME)."
else
  info "Building $IMAGE_NAME..."
  build_args=(-f "$DEPLOY_DIR/docker-compose.yml" build)
  [ "$PULL" = "1" ] && build_args+=(--pull)
  $COMPOSE "${build_args[@]}"
fi

# ---------------------------------------------------------------------------
# Seed a starter Console configuration into the data volume so the settings
# panel works before any chat starts. The image ships config.example.json in
# the npm package; copy it once and keep whatever the user later edits.
# ---------------------------------------------------------------------------
info "Seeding starter /data/config.json (Console model profiles)..."
if ! $COMPOSE -f "$DEPLOY_DIR/docker-compose.yml" --env-file "$DEPLOY_DIR/.env" run --rm \
  --entrypoint sh console -c \
  'test -f /data/config.json || cp /usr/local/lib/node_modules/catence/config.example.json /data/config.json'; then
  warn "Could not seed the starter config; the Console will ask for a model on the first chat instead."
fi

# ---------------------------------------------------------------------------
# Optionally generate the bcrypt password hash from the built image
# ---------------------------------------------------------------------------
if [ -z "$PASSWORD_HASH" ] && [ "$GENERATE_SECRETS" = "1" ]; then
  local_pw=""
  read -rsp "Enter the Console password (hidden): " local_pw || true
  printf '\n'
  local_pw2=""
  read -rsp "Confirm the Console password (hidden): " local_pw2 || true
  printf '\n'
  [ -n "$local_pw" ] || die "password cannot be empty"
  [ "$local_pw" = "$local_pw2" ] || die "passwords did not match"
  PASSWORD_HASH="$(printf '%s\n' "$local_pw" | docker run --rm -i \
    --entrypoint /opt/catence-console/bin/python "$IMAGE_NAME" \
    -c 'import bcrypt,sys;print(bcrypt.hashpw(sys.stdin.read().rstrip("\n").encode(),bcrypt.gensalt()).decode())')"
  [ -n "$PASSWORD_HASH" ] || die "failed to generate the bcrypt hash"
  write_env
  info "Generated CATENCE_CONSOLE_PASSWORD_HASH and saved it to $DEPLOY_DIR/.env."
fi

# ---------------------------------------------------------------------------
# Start only once the required login variables are all present
# ---------------------------------------------------------------------------
missing=""
[ -n "$USERNAME" ]      || missing="$missing CATENCE_CONSOLE_USERNAME"
[ -n "$PASSWORD_HASH" ] || missing="$missing CATENCE_CONSOLE_PASSWORD_HASH"
[ -n "$AUTH_SECRET" ]   || missing="$missing CHAINLIT_AUTH_SECRET"

if [ -n "$missing" ]; then
  info ""
  info "Scaffolding is ready in $DEPLOY_DIR/ (project $PROJECT, image $IMAGE_NAME)."
  info "Fill in the missing values in $DEPLOY_DIR/.env:$missing"
  info "and a model-provider key (OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENCODE_GO_API_KEY), then start it."
  info ""
  info "Generate the bcrypt hash for CATENCE_CONSOLE_PASSWORD_HASH with:"
  info "  $DEPLOY_DIR/hash-password.sh"
  info "  (or re-run this script with --generate-secrets to fill it interactively)"
  info "  fallback: docker run --rm -it --entrypoint /opt/catence-console/bin/catence-console $IMAGE_NAME auth hash-password"
  info ""
  info "Then start the stack:"
  info "  $COMPOSE -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env up -d"
  info "  (or re-run this script, which reads the values you saved in .env)"
  exit 0
fi

info "Starting $PROJECT..."
$COMPOSE -f "$DEPLOY_DIR/docker-compose.yml" --env-file "$DEPLOY_DIR/.env" up -d

# ---------------------------------------------------------------------------
# Summary and next steps
# ---------------------------------------------------------------------------
info ""
info "Deployed Catence Console ($CHANNEL):"
info "  version:  npm $NPM_VERSION / console $CONSOLE_VERSION"
info "  image:    $IMAGE_NAME"
info "  project:  $PROJECT"
info "  data:     $([ -n "$DATA_HOME" ] && printf '%s' "$DATA_HOME" || printf 'named volume %s' "$DATA_VOLUME")"
info "  console:  http://${BIND}:${PORT}  (login: $USERNAME)"
if [ "${MCP_BIND}" != "127.0.0.1" ]; then
  info "  mcp:      http://${MCP_BIND}:${MCP_PORT}/mcp  (exposed on ${MCP_BIND})"
else
  info "  mcp:      loopback only (use SSH port forwarding: ssh -L 8787:127.0.0.1:8787 <host>)"
fi
info ""
info "Next steps:"
info "  Initialize an athlete store:"
info "    $COMPOSE -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env run --rm --entrypoint catence-data console setup --athlete alex --label \"Alex\""
info "  Set a provider secret (stdin, never in shell history):"
info "    printf %s 'value' | $COMPOSE -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env run --rm -T --entrypoint catence-data console --athlete alex secret set --provider intervals --field apiKey --value-stdin"
info "  Edit the seeded Console model config (profiles and defaults):"
info "    $COMPOSE -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env run --rm --entrypoint sh console -c 'cat > /data/config.json'"
info "  Verify the model profiles and env vars:"
info "    $DEPLOY_DIR/doctor.sh"
info "    (or, with --home, edit <home>/config.json on the host; model keys stay in .env)"
  info "  Sync / backfill / inspect one athlete's data:"
  info "    $DEPLOY_DIR/sync.sh --athlete alex sync"
  info "    $DEPLOY_DIR/sync.sh --athlete alex backfill 2026-01-01"
  info "    $DEPLOY_DIR/sync.sh --athlete alex sync --detach   (background run; follow with progress --watch)"
  info "    $DEPLOY_DIR/sync.sh --athlete alex progress --watch"
  info "    $DEPLOY_DIR/sync.sh --athlete alex status"
  info "    $DEPLOY_DIR/sync.sh athletes"
info "  Discover OpenCode Go models into the config:"
info "    $COMPOSE -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env run --rm --entrypoint node console /usr/local/lib/node_modules/catence/scripts/discover-opencode-go.mjs --write /data/config.json"
info "  Check status / logs:"
info "    $COMPOSE -f $DEPLOY_DIR/docker-compose.yml ps"
info "    $COMPOSE -f $DEPLOY_DIR/docker-compose.yml logs -f"
info ""
if [ "${MCP_BIND}" != "127.0.0.1" ]; then
  info "MCP server is exposed on ${MCP_BIND}:${MCP_PORT}. Restrict access via Tailscale ACLs or firewall."
  info "The MCP server has no authentication — it trusts the caller's athleteId parameter."
else
  info "Keep the Console on loopback and front it with Cloudflare Tunnel (or a reverse"
  info "proxy); do not expose Catence port 8787 to the internet."
fi
