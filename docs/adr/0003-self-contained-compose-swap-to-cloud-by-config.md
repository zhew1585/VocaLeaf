# Self-contained Docker Compose stack; cloud services swapped in by configuration

Development and testing run the whole system from one `docker compose up` with no third-party paid service except the LLM provider: Postgres, MinIO for S3-compatible object storage, Kokoro-FastAPI on CPU, the Python worker, the TypeScript API, the web SPA, and Mailpit to catch outgoing email.
Before launch the same compose file is deployed to a server and each external dependency is switched by environment variables only: object storage to Cloudflare R2, SMTP to a transactional email service, optionally Postgres to a managed instance, and the worker to GPU hardware when throughput needs it.
We chose this so that the core flow (upload, parse, narrate) can be built and verified offline and cheaply, and so that moving to the cloud is a configuration change rather than a rewrite.

## Considered Options

- **Cloud-native from day one (Supabase Postgres and Auth, Modal serverless GPU, R2)**: rejected for now; every developer and every test run needs cloud accounts, and none of these can run inside a single compose file.
- **Self-hosted Supabase Auth (GoTrue) inside compose**: rejected; an extra service and its own schema only to send a six-digit code, while the API already owns every other rule.
- **Kokoro on GPU in development**: unnecessary; Kokoro-82M on a laptop CPU renders roughly ten times faster than playback, the same weights produce the same audio on CPU and GPU, and Docker on macOS cannot reach the Apple GPU anyway.

## Consequences

- Authentication is the API's own email one-time code (issued, emailed over SMTP, verified, then a session token is issued). Mailpit catches the mail locally, and the code is also written to the API log in development.
- The worker pulls jobs from the API and reports results back over HTTP. It never exposes a port and never touches the database, so the same image can run beside the stack, on a GPU machine, or on Modal later.
- Object storage, email, TTS endpoint and analytics are each reached through one configuration point (S3 endpoint and keys, SMTP settings, Kokoro URL, optional PostHog key). Analytics is a no-op when no key is set.
- Keep one Kokoro model file and precision (unquantized) across environments, so development and production audio are identical.
- Production adds a TLS-terminating reverse proxy (Caddy) to the same compose file.
