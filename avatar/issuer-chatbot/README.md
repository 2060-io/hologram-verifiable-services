# Avatar Issuer Chatbot

A conversational chatbot (via Hologram Messaging) that issues **Avatar credentials**: users pick a unique avatar name (`@name`), optionally attach an avatar image, and receive a verifiable credential. Avatars can be protected with a password or an authenticator app (TOTP) and restored from a new connection.

See [`../spec.md`](../spec.md) for the full behavioral spec.

## How it works

1. A user connects via Hologram Messaging (invitation/QR from the Avatar VS Agent)
2. First-time users are offered `Restore Avatar(s)` or `New Account` (authentication setup)
3. `/new` flow: choose a unique `@name` → optionally send an image (center-cropped, resized to at most 512×512, previewed through a MinIO presigned URL) → confirm → the Avatar credential is issued over DIDComm
4. The contextual menu adapts to state: `Reissue Credential` and `Delete Avatar` appear once the connection owns at least one avatar; `Password Setup` / `Authenticator Setup` appear when authenticated
5. `/restore` moves all avatars of an account to a new connectionId after a password or OTP challenge

## VS Agent integration

The chatbot drives its VS Agent through the Administration API v2 with the official client
[`@verana-labs/vs-agent-client`](https://www.npmjs.com/package/@verana-labs/vs-agent-client)
(pinned to `2.0.0-dev.105`, the VS Agent release it targets):

- Text messages: Basic Messages. Contextual menu: Action Menu (`sendMenu`, `perform` events). Choice prompts: Question Answer (`sendQuestion`; the answer text maps back to the option of its question).
- Images: Media Sharing (`shareMedia`, `share-media-received` events).
- Issuance: at startup the chatbot looks up the AnonCreds credential definition governed by `JSON_SCHEMA_CREDENTIAL_ID` (`listCredentialDefinitions`) and creates it when none exists (`createCredentialDefinition`). Each credential is a `createCredentialOffer` on the chat connection, with `autoAccept`. The VS Agent must hold an active ISSUER participant for the credential schema of that VTJSC.

The VS Agent delivers every event to one webhook URL. Set the VS Agent variable
`EVENTS_WEBHOOK_URL` (Helm chart value `eventsWebhookUrl`) to the `/events` route of this
server, for example `http://avatar-issuer-chatbot:4000/events`. VS Agent v2 no longer reads `EVENTS_BASE_URL`.

## Prerequisites

- Avatar VS Agent v2 running, with an ISSUER participant for the Avatar Credential schema and `EVENTS_WEBHOOK_URL` pointing at this server
- MinIO for image previews (started by `avatar/docker/docker-compose.yml`)
- Node.js 22+

## Local Usage

```bash
# Source configuration
source avatar/config.env

cd avatar/issuer-chatbot
npm install

# Run in development mode
npm run dev

# Or build and run
npm run build
npm start

# Unit tests (node:test via tsx)
npm test
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VS_AGENT_ADMIN_URL` | `http://localhost:3000` | Avatar VS Agent admin API base URL (the client adds `/v2`) |
| `JSON_SCHEMA_CREDENTIAL_ID` | — (required) | URL of the VTJSC of the Avatar Credential schema, as the ecosystem publishes it, e.g. `https://ecosystem.example/vt/schemas-avatar-jsc.json` |
| `CHATBOT_PORT` | `4000` | Server port (`POST /events`, `GET /health`) |
| `DATABASE_URL` | `sqlite:./data/sessions.db` | Accounts + avatars persistence (`sqlite:<path>` or `postgresql://…`) |
| `SERVICE_NAME` | `Example Verana Service` | Service display name |
| `ENABLE_ANONCREDS` | `true` | Use AnonCreds credential format |
| `LOG_LEVEL` | `info` | Logging level |
| `MINIO_ENDPOINT` | `localhost` | MinIO host |
| `MINIO_PORT` | `9000` | MinIO port |
| `MINIO_ACCESS_KEY` | `minioadmin` | MinIO access key |
| `MINIO_SECRET_KEY` | `minioadmin` | MinIO secret key |
| `MINIO_BUCKET` | `avatar-previews` | Bucket for processed image previews (24h lifecycle) |
| `MINIO_USE_SSL` | `false` | Use TLS for the internal MinIO connection |
| `MINIO_PUBLIC_URL` | `http://localhost:9000` | Public base URL used in presigned preview URLs |

## Docker

```bash
docker build -t avatar-issuer-chatbot .
docker run -p 4000:4000 \
  -e VS_AGENT_ADMIN_URL=http://host.docker.internal:3000 \
  -e JSON_SCHEMA_CREDENTIAL_ID=https://ecosystem.example/vt/schemas-avatar-jsc.json \
  avatar-issuer-chatbot
```
