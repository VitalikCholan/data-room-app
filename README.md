# Data Room App

A secure file management and sharing platform: folder organization inside per-owner
"data rooms," fine-grained sharing (public links or specific users), and read-only PDF
access for anyone a room is shared with. The API is NestJS 11 on Prisma 7 (via a driver
adapter) against PostgreSQL, storing files in S3-compatible object storage (MinIO
locally, Tigris in production).

## Getting started

```bash
cp .env.example apps/api/.env
pnpm install
pnpm infra:up                              # starts local Postgres (5433) and MinIO (9000)
pnpm --filter api prisma migrate deploy    # applies migrations to apps/api/.env's database
pnpm --filter api dev                      # http://localhost:3000, Swagger at /docs
```

`pnpm infra:down` stops the local containers (and drops their volumes).

## Repository layout

- `apps/api` — the NestJS API.
- `docs/superpowers/specs/` — the architecture and behaviour specs this application is
  built from, organized by plan.

Further setup detail (screenshots, the entity-relationship diagram, deployment) lands in
a later plan.
