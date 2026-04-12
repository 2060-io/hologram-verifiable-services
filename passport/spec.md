# Passport Issuer Service

## Overview

The Passport Issuer is a child service of the **organization** agent. It issues
passport credentials by reading NFC data from government-issued identity
documents (passports, ID cards) and verifying the holder's identity via a
liveness check (video call with gesture detection).

## Architecture

```
┌─ Organization (parent) ─────────────────────────────┐
│  Trust Registry owns passport-schema.json            │
│  Issues Service credential to Passport Issuer        │
└──────────────────────────────────────────────────────┘
        │ Service credential + ISSUER permission
        ▼
┌─ Passport Issuer ────────────────────────────────────┐
│                                                      │
│  ┌──────────────┐        ┌────────────────────────┐  │
│  │  VS Agent    │◄───────│  Gov ID Issuer App     │  │
│  │  (DIDComm)   │ admin  │  (hologram-gov-id-     │  │
│  │              │  API   │   issuer-vs)            │  │
│  └──────────────┘        └────────────────────────┘  │
│         │                       │          │         │
│         │                       │          │         │
│    ┌────┴────┐            ┌─────┴───┐ ┌────┴─────┐  │
│    │ Postgres│            │ Vision  │ │  WebRTC  │  │
│    │ + Redis │            │ Service │ │  Server  │  │
│    └─────────┘            └─────────┘ └──────────┘  │
│     (per-service)          (shared infrastructure)   │
└──────────────────────────────────────────────────────┘
```

## Containers

| Container | Image | Purpose |
|---|---|---|
| VS Agent | `veranalabs/vs-agent` (Helm chart) | DIDComm agent, credential store, DID management |
| Gov ID Issuer App | `io2060/hologram-gov-id-issuer-app` | NFC reading, liveness verification, credential issuance |
| PostgreSQL | `postgres:16-alpine` | Persistence for both VS Agent and issuer app |
| Redis | `redis:alpine` | Session cache for VS Agent |

## Shared Infrastructure

The following services are deployed separately (shared across all issuers) and
referenced by URL:

- **Vision Service** — face matching and liveness detection
- **WebRTC Server** — mediasoup-based video call relay

## Credential Flow

1. User connects to the Passport Issuer via Hologram mobile app
2. Issuer initiates NFC passport reading via the app
3. User taps their passport — eMRTD data is read and sent to the issuer
4. Issuer initiates a liveness check via WebRTC video call + Vision Service
5. On success, the issuer creates a passport credential with claims extracted
   from the eMRTD data (name, nationality, document number, face photo, etc.)
6. Credential is issued as a W3C Verifiable Credential (+ AnonCreds if enabled)

## Schema

The passport credential schema is defined in `organization/passport-schema.json`
and registered on the Verana network by the organization's trust registry
(`1_deploy-organization.yml`). The Passport Issuer discovers this schema from
the organization's DID document at deploy time.

## Deployment

### K8s (GHA workflow)

```bash
# Run all steps
gh workflow run "5_ Deploy Passport" --ref main -f step=all

# Individual steps
gh workflow run "5_ Deploy Passport" --ref main -f step=deploy
gh workflow run "5_ Deploy Passport" --ref main -f step=get-credentials
gh workflow run "5_ Deploy Passport" --ref main -f step=deploy-chatbot
```

### Local development

```bash
# 1. Start organization first (required for Service credential)
source organization/config.env
./organization/scripts/setup.sh

# 2. Set up passport issuer
source passport/config.env
./passport/scripts/setup.sh

# 3. Start the chatbot
./passport/scripts/start.sh
# — or with docker compose —
export NGROK_DOMAIN=your-domain.ngrok-free.app
docker compose -f passport/docker/docker-compose.yml up
```

## Configuration

See `passport/config.env` for all available settings.

Key variables:

| Variable | Description |
|---|---|
| `CHATBOT_IMAGE` | Gov ID Issuer App Docker image |
| `CUSTOM_SCHEMA_BASE_ID` | Must match organization's passport schema base ID |
| `VISION_URL` | URL of the shared Vision Service |
| `WEBRTC_SERVER_URL` | URL of the shared WebRTC Server |
| `CREDENTIAL_SCHEMA_ID` | Set at deploy time — URL of the passport VTJSC |
