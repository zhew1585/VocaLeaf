# API-first: a TypeScript API owns all business logic and the database

All clients (web SPA now, desktop via Tauri and an iOS app later) talk to one standalone HTTP API (TypeScript, Hono, OpenAPI contract generated from zod), which is the only component that reads or writes the database.
We chose this over Next.js server actions or direct Supabase access from clients, because both would tie business rules to the web client or split them between RLS and the API, forcing a rewrite for each new platform.

## Considered Options

- **Next.js with server actions / RSC**: rejected; logic only callable from the web.
- **Clients talk to Supabase directly with RLS**: rejected; rules end up in two places once an API is needed anyway.
- **Go API**: viable, rejected for now; the API is I/O-bound, a TS API shares zod types with the TS frontend without codegen, and keeps the stack to two languages (TS + Python).
- **All-Python (FastAPI)**: viable, rejected; loses direct type sharing with the frontend and TS-first AI streaming tooling.

## Consequences

- The book pipeline is a stateless Python worker that takes an ebook and a Voice and returns Chapters, Sentences with timings, and HLS audio in object storage. It never touches the database; it pulls jobs from the API and reports results back to it. Where it runs (beside the stack, on GPU hardware, on Modal) is a deployment choice, see ADR 0003.
- The web client is a plain SPA (Vite + React), not an SSR framework, so it can be wrapped as a desktop app with little change.
- The database is plain Postgres and authentication is the API's own email one-time code with a session token usable from every platform (amended by ADR 0003; originally Supabase Postgres and Auth).
