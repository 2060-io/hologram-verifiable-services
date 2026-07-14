#!/usr/bin/env bash
# =============================================================================
# Organization — Local Setup
# =============================================================================
#
# This script sets up the Organization Agent locally:
#   1. Deploys the VS Agent via Docker + ngrok
#   2. Sets up the veranad CLI account
#   3. Obtains Organization + Service credentials from ECS TR
#   4. Creates a Trust Registry with the schemas from SCHEMAS_CONFIG
#      (find-or-create, same logic as the 1_deploy-organization workflow)
#
# Idempotent: checks for existing resources before creating new ones.
#
# Prerequisites:
#   - Docker
#   - ngrok (authenticated)
#   - curl, jq
#
# Usage:
#   source organization/config.env
#   ./organization/scripts/setup.sh
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SERVICE_DIR/.." && pwd)"

# shellcheck source=../common/common.sh
source "${REPO_ROOT}/common/common.sh"

# ---------------------------------------------------------------------------
# Configuration — override via environment or config.env
# ---------------------------------------------------------------------------

NETWORK="${NETWORK:-testnet}"
VS_AGENT_IMAGE="${VS_AGENT_IMAGE:-veranalabs/vs-agent:latest}"
VS_AGENT_CONTAINER_NAME="${VS_AGENT_CONTAINER_NAME:-organization}"
VS_AGENT_ADMIN_PORT="${VS_AGENT_ADMIN_PORT:-3000}"
VS_AGENT_PUBLIC_PORT="${VS_AGENT_PUBLIC_PORT:-3001}"
VS_AGENT_DATA_DIR="${VS_AGENT_DATA_DIR:-${SERVICE_DIR}/data}"
SERVICE_NAME="${SERVICE_NAME:-Example Organization Service}"
USER_ACC="${USER_ACC:-org-vs-admin}"
OUTPUT_FILE="${OUTPUT_FILE:-${SERVICE_DIR}/ids.env}"

# Schemas (JSON array of {file, baseId}; file paths are relative to the repo root)
DEFAULT_SCHEMAS_CONFIG='[
  {"file": "organization/avatar-schema.json",   "baseId": "avatar"},
  {"file": "organization/passport-schema.json", "baseId": "passport"}
]'
SCHEMAS_CONFIG="${SCHEMAS_CONFIG:-$DEFAULT_SCHEMAS_CONFIG}"

# Trust Registry
TR_REGISTRY_URL="${TR_REGISTRY_URL:-}"
EGF_LANGUAGE="${EGF_LANGUAGE:-en}"
EGF_DOC_URL="${EGF_DOC_URL:-https://verana-labs.github.io/governance-docs/EGF/example.pdf}"
EGF_DOC_DIGEST="${EGF_DOC_DIGEST:-}"
VALIDATION_FEES="${VALIDATION_FEES:-0}"
ISSUANCE_FEES="${ISSUANCE_FEES:-0}"
VERIFICATION_FEES="${VERIFICATION_FEES:-0}"

# Organization details
ORG_NAME="${ORG_NAME:-Verana Example Organization}"
ORG_COUNTRY="${ORG_COUNTRY:-CH}"
ORG_LOGO_URL="${ORG_LOGO_URL:-https://verana.io/logo.svg}"
ORG_REGISTRY_ID="${ORG_REGISTRY_ID:-CH-CHE-123.456.789}"
ORG_ADDRESS="${ORG_ADDRESS:-Bahnhofstrasse 42, 8001 Zurich, Switzerland}"

# Service details
SERVICE_TYPE="${SERVICE_TYPE:-IssuerService}"
SERVICE_DESCRIPTION="${SERVICE_DESCRIPTION:-Organization service for the Verana demo ecosystem}"
SERVICE_LOGO_URL="${SERVICE_LOGO_URL:-https://verana.io/logo.svg}"
SERVICE_MIN_AGE="${SERVICE_MIN_AGE:-0}"
SERVICE_TERMS="${SERVICE_TERMS:-https://verana-labs.github.io/governance-docs/EGF/example.pdf}"
SERVICE_PRIVACY="${SERVICE_PRIVACY:-https://verana-labs.github.io/governance-docs/EGF/example.pdf}"

# ---------------------------------------------------------------------------
# Ensure veranad is available
# ---------------------------------------------------------------------------

if ! command -v veranad &> /dev/null; then
  log "veranad not found — downloading..."
  VERANAD_VERSION="${VERANAD_VERSION:-v0.9.5}"
  PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
  esac
  VERANAD_URL="https://github.com/verana-labs/verana-node/releases/download/${VERANAD_VERSION}/veranad-${PLATFORM}-${ARCH}"
  VERANAD_TMP="$(mktemp)"
  curl -sfL "$VERANAD_URL" -o "$VERANAD_TMP"
  # A disabled/renamed repo serves an HTML page with HTTP 200 — reject anything
  # that is not a real binary before installing it.
  if head -c 512 "$VERANAD_TMP" | grep -qi "<html\|not found"; then
    err "Download from ${VERANAD_URL} is not a binary — check VERANAD_VERSION and release assets"
    rm -f "$VERANAD_TMP"
    exit 1
  fi
  chmod +x "$VERANAD_TMP"
  if ! mv "$VERANAD_TMP" /usr/local/bin/veranad 2>/dev/null; then
    mkdir -p "${HOME}/.local/bin"
    mv "$VERANAD_TMP" "${HOME}/.local/bin/veranad"
    export PATH="${HOME}/.local/bin:$PATH"
  fi
  if ! veranad version >/dev/null 2>&1; then
    err "Installed veranad does not run — check VERANAD_VERSION (${VERANAD_VERSION}) and platform (${PLATFORM}-${ARCH})"
    exit 1
  fi
  ok "veranad installed: $(veranad version)"
fi

# ---------------------------------------------------------------------------
# Set network-specific variables
# ---------------------------------------------------------------------------

set_network_vars "$NETWORK"
log "Network: $NETWORK (chain: $CHAIN_ID)"

ADMIN_API="http://localhost:${VS_AGENT_ADMIN_PORT}"

# =============================================================================
# STEP 1: Deploy VS Agent
# =============================================================================

log "Step 1: Deploy VS Agent"

# Clean up any previous instance
docker rm -f "$VS_AGENT_CONTAINER_NAME" 2>/dev/null || true
rm -rf "${VS_AGENT_DATA_DIR}/data/wallet"

# Pull the image; fall back to local cache if pull fails
log "Pulling VS Agent image..."
if ! docker pull --platform linux/amd64 "$VS_AGENT_IMAGE" 2>&1 | tail -1; then
  if docker image inspect "$VS_AGENT_IMAGE" > /dev/null 2>&1; then
    warn "Pull failed — using locally cached image: $VS_AGENT_IMAGE"
  else
    err "Pull failed and no local image found for: $VS_AGENT_IMAGE"
    exit 1
  fi
fi

# Start ngrok tunnel for the public port
log "Starting ngrok tunnel on port ${VS_AGENT_PUBLIC_PORT}..."
pkill -f "ngrok http ${VS_AGENT_PUBLIC_PORT}" 2>/dev/null || true
sleep 1
ngrok http "$VS_AGENT_PUBLIC_PORT" --log=stdout > /tmp/ngrok-org-vs.log 2>&1 &
NGROK_PID=$!
sleep 5

NGROK_URL=$(curl -sf http://localhost:4040/api/tunnels | jq -r '.tunnels[0].public_url // empty')
if [ -z "$NGROK_URL" ]; then
  err "Failed to get ngrok URL. Is ngrok installed and authenticated?"
  exit 1
fi
NGROK_DOMAIN=$(echo "$NGROK_URL" | sed 's|https://||')
ok "ngrok tunnel: $NGROK_URL (domain: $NGROK_DOMAIN)"

# Start VS Agent container
log "Starting VS Agent container..."
mkdir -p "$VS_AGENT_DATA_DIR"
docker run --platform linux/amd64 -d \
  -p "${VS_AGENT_PUBLIC_PORT}:3001" \
  -p "${VS_AGENT_ADMIN_PORT}:3000" \
  -v "${VS_AGENT_DATA_DIR}:/root/.afj" \
  -e "AGENT_PUBLIC_DID=did:webvh:${NGROK_DOMAIN}" \
  -e "AGENT_LABEL=${SERVICE_NAME}" \
  -e "ENABLE_PUBLIC_API_SWAGGER=true" \
  --name "$VS_AGENT_CONTAINER_NAME" \
  "$VS_AGENT_IMAGE"

ok "VS Agent container started: $VS_AGENT_CONTAINER_NAME"

# Wait for the agent to initialize
log "Waiting for VS Agent to initialize (up to 180s)..."
if wait_for_agent "$ADMIN_API" 90; then
  ok "VS Agent is ready"
else
  err "VS Agent did not start within timeout"
  docker logs "$VS_AGENT_CONTAINER_NAME" 2>&1 | tail -20
  exit 1
fi

# Get agent DID
AGENT_DID=$(curl -sf "${ADMIN_API}/v1/agent" | jq -r '.publicDid')
if [ -z "$AGENT_DID" ] || [ "$AGENT_DID" = "null" ]; then
  err "Could not retrieve agent DID"
  exit 1
fi
ok "Agent DID: $AGENT_DID"

# =============================================================================
# STEP 2: Set up veranad CLI account
# =============================================================================

log "Step 2: Set up veranad CLI account"
setup_veranad_account "$USER_ACC" "$FAUCET_URL"

# =============================================================================
# STEP 3: Get ECS credentials (Organization + Service)
# =============================================================================

log "Step 3: Get ECS credentials"

# Discover ECS VTJSCs
ORG_VTJSC_OUTPUT=$(discover_ecs_vtjsc "$ECS_TR_PUBLIC_URL" "organization")
ORG_JSC_URL=$(echo "$ORG_VTJSC_OUTPUT" | sed -n '1p')

SERVICE_VTJSC_OUTPUT=$(discover_ecs_vtjsc "$ECS_TR_PUBLIC_URL" "service")
SERVICE_JSC_URL=$(echo "$SERVICE_VTJSC_OUTPUT" | sed -n '1p')
CS_SERVICE_ID=$(echo "$SERVICE_VTJSC_OUTPUT" | sed -n '2p')

# Clean up previous ECS credentials
cleanup_ecs_credentials "$ADMIN_API" "$ORG_JSC_URL" "$SERVICE_JSC_URL"

# Obtain Organization credential from ECS TR
log "Downloading logos..."
ORG_LOGO_DATA_URI=$(download_logo_data_uri "$ORG_LOGO_URL")
SERVICE_LOGO_DATA_URI=$(download_logo_data_uri "$SERVICE_LOGO_URL")

ORG_CLAIMS=$(jq -n \
  --arg id "$AGENT_DID" \
  --arg name "$ORG_NAME" \
  --arg logo "$ORG_LOGO_DATA_URI" \
  --arg rid "$ORG_REGISTRY_ID" \
  --arg addr "$ORG_ADDRESS" \
  --arg cc "$ORG_COUNTRY" \
  '{id: $id, name: $name, logo: $logo, registryId: $rid, address: $addr, countryCode: $cc}')

issue_remote_and_link "$ECS_TR_ADMIN_API" "$ADMIN_API" "organization" "$ORG_JSC_URL" "$AGENT_DID" "$ORG_CLAIMS"

# Ensure ISSUER permission for Service schema
if EXISTING_PERM=$(find_active_issuer_perm "$CS_SERVICE_ID" "$AGENT_DID"); then
  ok "Active ISSUER permission already exists: $EXISTING_PERM — skipping"
else
  log "Creating ISSUER permission for Service schema..."
  check_balance "$USER_ACC"
  EFFECTIVE_FROM=$(future_timestamp 15)
  submit_tx "create_permission" "permission_id" \
    veranad tx perm create-perm "$CS_SERVICE_ID" issuer "$AGENT_DID" \
    --effective-from "$EFFECTIVE_FROM"
  sleep 21
fi

# Self-issue Service credential
SERVICE_CLAIMS=$(jq -n \
  --arg id "$AGENT_DID" \
  --arg name "$SERVICE_NAME" \
  --arg type "$SERVICE_TYPE" \
  --arg desc "$SERVICE_DESCRIPTION" \
  --arg logo "$SERVICE_LOGO_DATA_URI" \
  --argjson age "$SERVICE_MIN_AGE" \
  --arg terms "$SERVICE_TERMS" \
  --arg privacy "$SERVICE_PRIVACY" \
  '{id: $id, name: $name, type: $type, description: $desc, logo: $logo, minimumAgeRequired: $age, termsAndConditions: $terms, privacyPolicy: $privacy}')

issue_remote_and_link "$ADMIN_API" "$ADMIN_API" "service" "$SERVICE_JSC_URL" "$AGENT_DID" "$SERVICE_CLAIMS"

# =============================================================================
# STEP 4: Create Trust Registry + credential schema
# =============================================================================

log "Step 4: Create Trust Registry (find-or-create, same logic as the deploy workflow)"

CONTROLLER_ADDR=$(veranad keys show "$USER_ACC" -a --keyring-backend test)
log "Controller: $CONTROLLER_ADDR"

TRUST_REG_ID=""
SCHEMA_IDS=""

SCHEMA_COUNT=$(echo "$SCHEMAS_CONFIG" | jq '. | length')
if [ "$SCHEMA_COUNT" -eq 0 ]; then
  ok "No schemas configured in SCHEMAS_CONFIG — skipping trust registry setup"
else
  log "Processing ${SCHEMA_COUNT} schema(s) from SCHEMAS_CONFIG"

  # -------------------------------------------------------------------------
  # Find or create trust registry
  # -------------------------------------------------------------------------

  TR_URL="${INDEXER_URL}/verana/tr/v1/list?controller=${CONTROLLER_ADDR}&only_active=true"
  log "Querying indexer for existing trust registries: $TR_URL"
  TR_RESP=$(curl -s -w '\n%{http_code}' "$TR_URL")
  TR_HTTP=$(echo "$TR_RESP" | tail -1)
  TR_BODY=$(echo "$TR_RESP" | sed '$d')
  if [ "$TR_HTTP" -ne 200 ]; then
    err "Indexer query failed (HTTP $TR_HTTP). Cannot safely proceed — aborting to avoid duplicate trust registries."
    err "Response: $TR_BODY"
    exit 1
  fi

  # Filter client-side for trust registries matching our DID, sorted by ID ascending
  MATCHING_TR_IDS=$(echo "$TR_BODY" | jq -r --arg did "$AGENT_DID" \
    '[.trust_registries[] | select(.did == $did)] | sort_by(.id) | .[].id')

  TRUST_REG_ID=$(echo "$MATCHING_TR_IDS" | head -1)

  if [ -n "$TRUST_REG_ID" ]; then
    ok "Found existing active trust registry: TR=$TRUST_REG_ID (DID=$AGENT_DID)"

    # Archive any duplicate active trust registries (keep only the oldest)
    STALE_TR_IDS=$(echo "$MATCHING_TR_IDS" | tail -n +2)
    if [ -n "$STALE_TR_IDS" ]; then
      log "Found $(echo "$STALE_TR_IDS" | wc -l | tr -d ' ') duplicate active trust registries — archiving..."
      for STALE_TR in $STALE_TR_IDS; do
        log "Archiving duplicate trust registry: TR=$STALE_TR"
        check_balance "$USER_ACC"
        veranad tx tr archive-trust-registry "$STALE_TR" true \
          --from "$USER_ACC" --chain-id "$CHAIN_ID" --keyring-backend test \
          --fees "$FEES" --node "$NODE_RPC" \
          --output json -y > /dev/null 2>&1 || true
        ok "Archived duplicate trust registry: TR=$STALE_TR"
      done
    fi
  else
    log "No active trust registry found for DID=$AGENT_DID — creating..."
    if [ -z "$EGF_DOC_DIGEST" ]; then
      EGF_DOC_DIGEST=$(compute_sri_digest "$EGF_DOC_URL")
      ok "EGF digest: $EGF_DOC_DIGEST"
    fi

    TR_REGISTRY_URL="${TR_REGISTRY_URL:-${NGROK_URL}}"

    check_balance "$USER_ACC"
    TRUST_REG_ID=$(submit_tx "create_trust_registry" "trust_registry_id" \
      veranad tx tr create-trust-registry \
      "$AGENT_DID" "$EGF_LANGUAGE" "$EGF_DOC_URL" "$EGF_DOC_DIGEST" \
      --aka "$TR_REGISTRY_URL")
    ok "Trust registry created: TR=$TRUST_REG_ID"
  fi

  # -------------------------------------------------------------------------
  # Per-schema: find or create schema + root perm + JSC
  # -------------------------------------------------------------------------

  # Fetch all active schemas for this trust registry (once)
  CS_URL="${INDEXER_URL}/verana/cs/v1/list?tr_id=${TRUST_REG_ID}&only_active=true"
  log "Querying indexer for existing schemas: $CS_URL"
  CS_RESP=$(curl -s -w '\n%{http_code}' "$CS_URL")
  CS_HTTP=$(echo "$CS_RESP" | tail -1)
  CS_BODY=$(echo "$CS_RESP" | sed '$d')
  if [ "$CS_HTTP" -ne 200 ]; then
    err "Indexer schema query failed (HTTP $CS_HTTP). Aborting."
    err "Response: $CS_BODY"
    exit 1
  fi

  # Fetch existing JSC credentials from the agent (once)
  JSC_LIST=$(curl -sf "${ADMIN_API}/v1/vt/json-schema-credentials" 2>/dev/null || echo '{"data":[]}')

  for i in $(seq 0 $((SCHEMA_COUNT - 1))); do
    SCHEMA_ENTRY=$(echo "$SCHEMAS_CONFIG" | jq -c ".[$i]")
    SCHEMA_FILE=$(echo "$SCHEMA_ENTRY" | jq -r '.file')
    SCHEMA_BASE_ID=$(echo "$SCHEMA_ENTRY" | jq -r '.baseId')

    # Schema paths in SCHEMAS_CONFIG are relative to the repo root
    case "$SCHEMA_FILE" in
      /*) : ;;
      *) SCHEMA_FILE="${REPO_ROOT}/${SCHEMA_FILE}" ;;
    esac

    log "Schema $((i+1))/${SCHEMA_COUNT}: '${SCHEMA_BASE_ID}' (${SCHEMA_FILE})"

    if [ ! -f "$SCHEMA_FILE" ]; then
      err "Schema file not found: ${SCHEMA_FILE}"
      exit 1
    fi
    # Load and canonize local schema (strip $id, sort keys)
    SCHEMA_JSON=$(jq -c '.' "$SCHEMA_FILE")
    LOCAL_CANON=$(echo "$SCHEMA_JSON" | jq -Sc 'del(."$id")')

    # --- Check if this schema already exists on-chain ---
    CS_ID=""
    while IFS= read -r entry; do
      [ -z "$entry" ] && continue
      ON_CHAIN_JS=$(echo "$entry" | jq -r '.json_schema // empty')
      [ -z "$ON_CHAIN_JS" ] && continue
      ON_CHAIN_CANON=$(echo "$ON_CHAIN_JS" | jq -Sc 'del(."$id")')
      if [ "$LOCAL_CANON" = "$ON_CHAIN_CANON" ]; then
        CS_ID=$(echo "$entry" | jq -r '.id')
        break
      fi
    done <<< "$(echo "$CS_BODY" | jq -c '.schemas[]?' 2>/dev/null)"

    if [ -n "$CS_ID" ]; then
      ok "Schema '${SCHEMA_BASE_ID}' already exists on-chain: CS=$CS_ID — skipping creation"
    else
      # Create credential schema (issuer_mode=ECOSYSTEM, verifier_mode=OPEN)
      log "Creating credential schema for '${SCHEMA_BASE_ID}'..."
      check_balance "$USER_ACC"
      CS_ID=$(submit_tx "create_credential_schema" "credential_schema_id" \
        veranad tx cs create-credential-schema "$TRUST_REG_ID" "$SCHEMA_JSON" \
        --issuer-grantor-validation-validity-period '{"value":0}' \
        --verifier-grantor-validation-validity-period '{"value":0}' \
        --issuer-validation-validity-period '{"value":0}' \
        --verifier-validation-validity-period '{"value":0}' \
        --holder-validation-validity-period '{"value":0}' \
        3 1)
      ok "Credential schema created: CS=$CS_ID"

      # Create root permission
      check_balance "$USER_ACC"
      EFFECTIVE_FROM=$(future_timestamp 15)
      ROOT_PERM_ID=$(submit_tx "create_root_permission" "root_permission_id" \
        veranad tx perm create-root-perm \
        "$CS_ID" "$AGENT_DID" \
        "$VALIDATION_FEES" "$ISSUANCE_FEES" "$VERIFICATION_FEES" \
        --effective-from "$EFFECTIVE_FROM")
      ok "Root permission created: PERM=$ROOT_PERM_ID"
      sleep 21
    fi

    # --- Check if JSC already exists for this schema ---
    VPR_REF="vpr:verana:${CHAIN_ID}/cs/v1/js/${CS_ID}"
    EXISTING_JSC=$(echo "$JSC_LIST" | jq -r \
      --arg sid "$VPR_REF" \
      '.data[] | select(.schemaId == $sid) | .credential.id // empty' 2>/dev/null | head -1)

    if [ -n "$EXISTING_JSC" ]; then
      ok "JSC already exists for CS=$CS_ID (cred=$EXISTING_JSC) — skipping"
    else
      log "Creating JSC for '${SCHEMA_BASE_ID}' (CS=$CS_ID)..."
      JSC_RESP=$(curl -s -w '\n%{http_code}' -X POST "${ADMIN_API}/v1/vt/json-schema-credentials" \
        -H 'Content-Type: application/json' \
        -d "{\"schemaBaseId\": \"${SCHEMA_BASE_ID}\", \"jsonSchemaRef\": \"${VPR_REF}\"}")
      JSC_HTTP=$(echo "$JSC_RESP" | tail -1)
      JSC_BODY_RESP=$(echo "$JSC_RESP" | sed '$d')
      if [ "$JSC_HTTP" -ge 400 ]; then
        err "Failed to create JSC for '${SCHEMA_BASE_ID}' (HTTP $JSC_HTTP): $JSC_BODY_RESP"
        exit 1
      fi
      ok "JSC created for '${SCHEMA_BASE_ID}' (CS=$CS_ID)"

      # Refresh JSC list for subsequent iterations
      sleep 3
      JSC_LIST=$(curl -sf "${ADMIN_API}/v1/vt/json-schema-credentials" 2>/dev/null || echo '{"data":[]}')
    fi

    SCHEMA_IDS="${SCHEMA_IDS:+${SCHEMA_IDS},}${SCHEMA_BASE_ID}=${CS_ID}"
    ok "Schema '${SCHEMA_BASE_ID}' done: TR=$TRUST_REG_ID CS=$CS_ID"
  done

  ok "Trust Registry setup complete: TR=$TRUST_REG_ID, ${SCHEMA_COUNT} schema(s) processed"
fi

# =============================================================================
# STEP 5: AnonCreds credential definition — SKIPPED
# =============================================================================
# NOTE: organization no longer creates a credential definition.
# Each issuer (avatar, issuer-web-vs) creates its own credential
# definition pointing to the jsonSchemaCredential published by this service.

log "Step 5: AnonCreds credential definition — skipped (issuers create their own)"

# =============================================================================
# Save IDs
# =============================================================================

log "Saving resource IDs to ${OUTPUT_FILE}"

cat > "$OUTPUT_FILE" <<EOF
# Organization — Resource IDs
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Network: ${NETWORK}

AGENT_DID=${AGENT_DID}
NGROK_URL=${NGROK_URL}
VS_AGENT_CONTAINER_NAME=${VS_AGENT_CONTAINER_NAME}
VS_AGENT_ADMIN_PORT=${VS_AGENT_ADMIN_PORT}
VS_AGENT_PUBLIC_PORT=${VS_AGENT_PUBLIC_PORT}
USER_ACC=${USER_ACC}
TRUST_REG_ID=${TRUST_REG_ID:-}
SCHEMA_IDS=${SCHEMA_IDS:-}
EOF

ok "IDs saved to ${OUTPUT_FILE}"

# =============================================================================
# Summary
# =============================================================================

log "Organization setup complete!"
echo ""
echo "  Agent DID         : $AGENT_DID"
echo "  Public URL        : $NGROK_URL"
echo "  DID Document      : ${NGROK_URL}/.well-known/did.json"
echo "  Admin API         : $ADMIN_API"
echo "  Trust Registry    : ${TRUST_REG_ID:-n/a}"
echo "  Schema IDs        : ${SCHEMA_IDS:-n/a}"
echo ""
echo "  To stop:"
echo "    docker stop $VS_AGENT_CONTAINER_NAME"
echo "    kill $NGROK_PID  # ngrok"
echo ""
