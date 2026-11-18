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

Logging in needs an invited email.
Add yours to the allowlist (see [Login](#login)):

```sh
docker compose exec api node dist/scripts/allowlist.js add you@example.com --by your-name
```

Open http://localhost:8080, enter that email and click 发送验证码 (send code).
The six-digit code arrives in Mailpit at http://localhost:8025, and the API log prints it too (`docker compose logs api`).
After logging in, upload an EPUB without DRM, for example [Pride and Prejudice from Standard Ebooks](https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice).
The page then opens the book detail view.
The book shows 解析中 (parsing) first, then 生成中 (generating) once parsing finishes, with every chapter and its sentence count.
A few seconds later the first narrated chapter has its first audio segment and 开始收听 (start listening) becomes clickable; it opens the 专注页 (focus page) with the player.
Once every narrated chapter is generated, the book moves to 已就绪 (ready).

To stop the stack, run `docker compose down`.
To also delete all data, run `docker compose down -v`.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_PORT` | `8080` | Port for the web app |
| `WORKER_TOKEN` | `dev-worker-token-change-me` | Shared secret the worker sends to `/api/internal`. Change it before any public deployment. |
| `APP_ENV` | `development` | `development` also prints login codes to the API log and lets the session cookie work over plain http. Set `production` for any deployment behind HTTPS. |
| `SMTP_URL` | `smtp://mailpit:1025` | Where login code emails go, as a nodemailer SMTP URL, for example `smtps://user:pass@smtp.example.com:465` |
| `MAIL_FROM` | `拾页 <login@vocaleaf.local>` | Sender of login code emails |
| `MAILPIT_PORT` | `8025` | Port for Mailpit's inbox |
| `JOB_LEASE_SECONDS` | `600` | How long a worker holds a claimed job. The worker renews it with a heartbeat every third of the lease; once heartbeats stop and the lease expires, another worker can claim the job. |
| `PAUSE_SENTENCE_MS` | `300` | Silence between two sentences of one paragraph (PRD 4.7.2) |
| `PAUSE_PARAGRAPH_MS` | `800` | Silence between paragraphs |
| `PAUSE_CHAPTER_START_MS` | `1500` | Silence before a chapter's first sentence |

## Services

| Service | What it does |
| --- | --- |
| `web` | Vite and React single-page app served by nginx, which also proxies `/api` to the API |
| `api` | TypeScript service on Hono and the only component that reads or writes the database. The OpenAPI document is at `/api/openapi.json`. |
| `worker` | Stateless Python process. It claims jobs from the API, reads the uploaded file from object storage, and reports results back to the API. It has no database connection. |
| `postgres` | Database. Only the API shares its network. |
| `storage` | S3-compatible object storage (RustFS) |
| `kokoro` | Kokoro-FastAPI on CPU, pinned by image digest. See [Audio](#audio). |
| `mailpit` | Catches every email the API sends and shows it at http://localhost:8025; nothing leaves the machine |

The API and the worker reach object storage only through `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.
To use Cloudflare R2, set these five variables to your R2 values (with `S3_REGION=auto`) and remove the `storage` service.
To send real email, set `SMTP_URL` and `MAIL_FROM` for your SMTP service and remove the `mailpit` service.

### Job leases

When a worker claims a job, it gets a lease of `JOB_LEASE_SECONDS` and the claim number `attempt`.
While the job runs, the worker sends a heartbeat every third of the lease, so a chapter that takes longer than the lease to generate on CPU is never claimed by a second worker.
If the worker crashes or restarts, its heartbeats stop, any worker can claim the job again once the lease expires, and each new claim increases `attempt` by one.
Workers can claim a job at most 3 times (PRD 4.7.2).
If the third claim also times out, the job fails: a parse job moves the book to 解析失败 (parsing failed), a generation job moves its chapter to 生成失败 (generation failed) and the book carries on.
Every callback and heartbeat must send back its `attempt`.
The API answers 409 when the job was claimed again or has already finished, so a late callback never overwrites a newer result; a worker whose heartbeat gets 409 drops the job.
Jobs are claimed by their position in their book first (parse = 0, the nth narrated chapter = n), then by age, so a newly uploaded book never waits behind other books' later chapters.

### Audio

After parsing, the API queues one `render_chapter` job per narrated chapter (Skipped ones excluded), in chapter order.
The worker sends the sentences of each paragraph to Kokoro's `/dev/captioned_speech` together (PCM plus word timestamps), so the voice hears their context and carries its intonation across them; paragraphs longer than about 400 characters are split at sentence boundaries.
It maps the returned words back to each sentence and keeps each sentence's voiced span, replacing Kokoro's own pauses with the configured ones: `PAUSE_CHAPTER_START_MS` before a chapter's first sentence, `PAUSE_PARAGRAPH_MS` between paragraphs and `PAUSE_SENTENCE_MS` between sentences.
If the words of a paragraph cannot be matched to its sentences, that paragraph is spoken again one sentence at a time.
The chapter is streamed through one ffmpeg process into HLS: AAC mono 48 kbps, segments of about 10 seconds (MPEG-TS).
It writes each segment to object storage and reports it as soon as it is complete, so a book is playable after its first segment.
The book's playlist is `GET /api/books/{id}/audio.m3u8`: the segments of every narrated chapter in chapter order, with `EXT-X-DISCONTINUITY` between chapters.
While the book generates it is an EVENT playlist that players reload as it grows; `EXT-X-ENDLIST` is added once the book is ready.
Segments are served from object storage through `GET /api/books/{id}/segments/{segmentId}.ts`, with the same ownership check as the book.
Published segments are never taken back: a re-claimed chapter is generated again but only appends the segments the earlier claim had not written, and a chapter that fails halfway keeps what it published.
A sentence's `start_ms` and `end_ms` cover exactly its voiced span (the pauses around it belong to no sentence); they are stored relative to its chapter and returned as positions in the whole book's audio. `word_timings` are relative to the sentence's own start.
The book's `durationMs` is exact once it is ready; while it generates, the remaining chapters are estimated at the generated chapters' pace per character, and the player shows whole-book progress against it.

The Kokoro model is pinned to the unquantized `kokoro-v1_0.pth` (hexgrad/Kokoro-82M, sha256 `496dba11…c17f`).
It ships inside the `kokoro-fastapi-cpu:v0.10.0` image, which compose pins by digest, and `DOWNLOAD_MODEL=false` stops it from fetching weights at start, so development and production run the same model file (ADR 0003).

The voice mapping (PRD 4.7.2) is in `worker/src/vocaleaf_worker/tts.py`: US female `af_heart`, US male `am_michael`, UK female `bf_emma`, UK male `bm_george`.
Samples of all four voices are in [docs/samples/issue-2/](docs/samples/issue-2/). To render them again:

```sh
docker compose run --rm --no-deps -v "$PWD/worker/scripts:/scripts:ro" -v "$PWD/docs/samples/issue-2:/out" \
  worker python /scripts/voice_samples.py /out
```

### Login

Only invited emails can log in (PRD 4.1.1); there is no password and no sign-up.
The login page asks for an email and calls `POST /api/auth/code`.
An email that is not on the allowlist gets 该邮箱暂未获得内测资格 (not invited) and no email is sent.
An invited email gets a six-digit code over SMTP, valid for 10 minutes; another code can be sent 60 seconds later, and it replaces the first.
`POST /api/auth/login` with the right code creates the account on first login and starts a session.
A code is used once and stops working after five wrong guesses.

The session is a random token in an HttpOnly, SameSite=Lax cookie; the database keeps only its SHA-256.
A cookie rather than a bearer header, because the browser fetches HLS audio by itself, and native HLS on iOS Safari cannot add headers.
Sessions do not expire: `GET /api/me`, which the app calls on every load, renews the cookie's 400-day lifetime.
Each device has its own session, and `POST /api/auth/logout` ends only that device's.
Every API route needs a session except `/api/auth/*`, `/api/health`, `/api/openapi.json` and the worker's `/api/internal/*` (which needs `WORKER_TOKEN`).

Operators manage the allowlist with a script inside the `api` container.
`add` and `remove` write every email to the audit log (`audit_log`, PRD 4.6.2) with the operator named by `--by`; removing an email also logs that user out on every device.

```sh
docker compose exec api node dist/scripts/allowlist.js add a@example.com b@example.com --by allen
docker compose exec api node dist/scripts/allowlist.js remove a@example.com --by allen
docker compose exec api node dist/scripts/allowlist.js list
```

Books uploaded before login existed belonged to a fixed development user; the migration gives them to the account `dev@vocaleaf.local`, so allowlisting that email reaches them.

## Develop and test

```sh
npm ci                     # dependencies for api and web (npm workspaces)
npm test                   # api tests (in-memory Postgres via PGlite) and web tests
npm run typecheck
(cd worker && uv sync && uv run pytest && uv run ruff check && uv run pyright)

npm run e2e:up             # start the stack with a 5-second lease, which the lease tests need
npm run test:e2e           # end-to-end tests against the running stack, real Kokoro included (about 2 minutes;
                           # ends every unfinished job on the stack; each test file logs in as a fresh
                           # allowlisted email, reading its code from Mailpit)
```

After you change `api/src/db/schema.ts`, run `npm run db:generate -w api` to generate a migration.
The API applies pending migrations when it starts.
