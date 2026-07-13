# Playground

Landing page for the Verifiable Services showcase, served at [vs.hologram.zone](https://vs.hologram.zone).

- Next.js (App Router) client page listing each deployed service with a short description, links, and a QR code to connect (each VS Agent's `/qr` endpoint).
- Built and deployed by workflow `6_deploy-playground.yml` as a raw K8s Deployment/Service/Ingress (no Helm chart).
- Source: `playground/app/page.tsx` — the service cards are currently hardcoded in the `services` array.
