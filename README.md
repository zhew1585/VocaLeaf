# VocaLeaf (拾页)

VocaLeaf turns your own English ebooks into audiobooks and lets you mark the sentences you want to study while you listen.
The domain glossary is in [CONTEXT.md](CONTEXT.md), the product requirements are in [docs/prd-mvp.md](docs/prd-mvp.md), and the architecture decisions are in [docs/adr/](docs/adr/).

## Run the stack

You need Docker (Docker Desktop, or Docker Engine with Compose v2).
You do not need any cloud account.

```sh
docker compose up --build
```

The first start builds three images and pulls the Kokoro image (about 4.5 GB).
Later starts take a few seconds.

Open http://localhost:8080 and upload an EPUB without DRM, for example [Pride and Prejudice from Standard Ebooks](https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice).
The page then opens the book detail view.
The book shows 解析中 (parsing) first, then 生成中 (generating) once parsing finishes, with every chapter and its sentence count.

To stop the stack, run `docker compose down`.
To also delete all data, run `docker compose down -v`.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_PORT` | `8080` | Port for the web app |
| `WORKER_TOKEN` | `dev-worker-token-change-me` | Shared secret the worker sends to `/api/internal`. Change it before any public deployment. |
| `JOB_LEASE_SECONDS` | `600` | How long a worker holds a claimed job. When the lease expires without a callback, another worker can claim the job. |

## Services

| Service | What it does |
| --- | --- |
| `web` | Vite and React single-page app served by nginx, which also proxies `/api` to the API |
| `api` | TypeScript service on Hono and the only component that reads or writes the database. The OpenAPI document is at `/api/openapi.json`. |
| `worker` | Stateless Python process. It claims jobs from the API, reads the uploaded file from object storage, and reports results back to the API. It has no database connection. |
| `postgres` | Database. Only the API shares its network. |
| `storage` | S3-compatible object storage (RustFS) |
| `kokoro` | Kokoro-FastAPI on CPU. Audio generation starts using it in [#2](https://github.com/zhew1585/VocaLeaf/issues/2). |

The API and the worker reach object storage only through `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.
To use Cloudflare R2, set these five variables to your R2 values (with `S3_REGION=auto`) and remove the `storage` service.

### Job leases

When a worker claims a job, it gets a lease of `JOB_LEASE_SECONDS` and the claim number `attempt`.
If the worker crashes or restarts, any worker can claim the job again once the lease expires, and each new claim increases `attempt` by one.
Workers can claim a job at most 3 times (PRD 4.7.2).
If the third claim also times out, the job fails and the book moves to 解析失败 (parsing failed).
Every callback must send back its `attempt`.
The API answers 409 when the job was claimed again or has already finished, so a late callback never overwrites a newer result.

Sign-in comes in [#6](https://github.com/zhew1585/VocaLeaf/issues/6).
Until then every request runs as one fixed development user, defined in [api/src/dev-identity.ts](api/src/dev-identity.ts).

## Develop and test

```sh
npm ci                     # dependencies for api and web (npm workspaces)
npm test                   # api tests (in-memory Postgres via PGlite) and web tests
npm run typecheck
(cd worker && uv sync && uv run pytest && uv run ruff check && uv run pyright)

npm run e2e:up             # start the stack with a 5-second lease, which the lease tests need
npm run test:e2e           # end-to-end tests against the running stack
```

After you change `api/src/db/schema.ts`, run `npm run db:generate -w api` to generate a migration.
The API applies pending migrations when it starts.
