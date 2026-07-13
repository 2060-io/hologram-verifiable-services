# Hologram Verifiable Services — Specifications

The concept, trust model, and deployment architecture are described in the [README](README.md).

Per-service specifications:

| Service | Spec |
|---------|------|
| avatar | [avatar/spec.md](avatar/spec.md) — issuer chatbot behavior, avatar persistence/recovery, contextual menu, media storage |
| passport | [passport/spec.md](passport/spec.md) — NFC eMRTD + liveness issuance architecture |
| playground | [playground/spec.md](playground/spec.md) — landing page |

The AI agents (github-agent, wise-agent, x-agent) are configuration packs for [hologram-ai-agent](https://github.com/2060-io/hologram-ai-agent); their behavior is defined by each service's `agent-pack.yaml` and documented in its README.
