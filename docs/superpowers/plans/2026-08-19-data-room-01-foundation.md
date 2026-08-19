# Data Room — Plan 01: Foundation, Auth and Deployment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan set:** this is one of six. Order: 01 foundation → 02 tree API → 03 files & sharing API → 04 web shell → 05 web browser → 06 sharing UI & release. See `2026-08-19-data-room-00-overview.md`.

**Goal:** Stand up the monorepo, local infrastructure, the Nest error contract, the database schema, authentication, and both live deployments — before a single feature exists.

**Architecture:** pnpm workspace with apps/api (NestJS + Prisma) and apps/web (Vite). Deployment happens in Task 3, on a bare app exposing /health, because cross-site cookies and bucket CORS are environment failures that cannot be found locally. The schema lands with three hand-written SQL indexes Prisma cannot express.

**Tech Stack:** NestJS 10, Prisma 5, PostgreSQL 16, argon2, Passport (JWT + Google), class-validator + class-transformer, Jest + supertest, Docker Compose (Postgres + MinIO), Railway, Vercel.

**Spec:** `docs/superpowers/specs/2026-08-19-data-room-design.md`

**Prerequisite:** none — this is the first plan.

**Done when:** `curl https://<vercel-host>/api/health` returns `{"status":"ok"}`, `pnpm --filter api test` and `test:e2e` are green, and a user can register, sign in, and read `/auth/me`.

## Global Constraints

- Node 20+, pnpm 9+. Package manager is pnpm workspaces only — no Turborepo, no Nx.
- All packages live under `apps/*`. There is no `packages/` directory and no shared types package.
- `apps/web` must never import from `apps/api` or from `@prisma/client`. Frontend types come only from `apps/web/src/api/schema.d.ts`, generated from `openapi.json`.
- Uploads: PDF only (`application/pdf`), hard cap **50 MB**, enforced only in `UploadsService.confirm` via a bucket `HEAD`.
- Presigned PUT TTL 15 minutes. Presigned GET TTL 5 minutes.
- Share tokens: 32 random bytes, base64url. Store **only** `sha256(token)` in `Share.tokenHash`. Show the token once.
- Access JWT TTL 15 minutes. Refresh cookie TTL 7 days, `httpOnly; Secure; SameSite=Lax; Path=/`.
- Blob keys are always derived server-side as `rooms/{roomId}/nodes/{nodeId}/v{versionNo}`. Never client-supplied.
- HTTP codes are fixed by spec §4.3: 401 unauthenticated · 404 no access (never 403 — it would confirm existence) · 403 role insufficient · 410 deleted ancestor or revoked link · 409 name conflict or move cycle · 413 over 50 MB · 415 wrong MIME · 422 validation.
- `Node.status = PENDING` rows are excluded from every listing, for every caller.
- Soft delete has no user-facing restore. No trash UI. No editor role. No OS folder upload. No audit log.
- Every repository method that reads nodes takes an `AccessContext` and applies its scope prefix. A read query that does not carry scope is a bug.
- Commit after every task. Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`).

## File Structure

### `apps/api/src`

| Path | Responsibility |
|---|---|
| `main.ts` | Bootstrap, CORS, cookie parser, global pipes/filters/interceptors, Swagger |
| `app.module.ts` | Module composition |
| `config/env.ts` | class-validator env schema + typed `AppEnv` |
| `common/errors.ts` | `DomainError` + error codes |
| `common/filters/domain-exception.filter.ts` | `DomainError` → HTTP status |
| `common/filters/prisma-exception.filter.ts` | Prisma `P2002` → 409, `P2025` → 404 (Task 4) |
| `common/interceptors/bigint.interceptor.ts` | `BigInt` → `number` in responses |
| `prisma/prisma.service.ts` | Prisma client lifecycle |
| `health/health.controller.ts` | `GET /health` |
| `auth/*` | Register, login, refresh, `/auth/me`, JWT strategy, Google strategy, `JwtAuthGuard` |
| `rooms/*` | Room CRUD, root-node creation transaction, `shared-with-me` |
| `nodes/node-path.ts` | Pure path helpers — the only place path strings are constructed |
| `nodes/cursor.ts` | Keyset cursor encode/decode |
| `nodes/name-conflict.ts` | `resolveAvailableName` for KEEP_BOTH |
| `nodes/nodes.repository.ts` | Scope-aware node queries |
| `nodes/nodes.service.ts` | Create folder, rename, list with breadcrumbs |
| `nodes/move.service.ts` | Move in one locked transaction |
| `nodes/delete.service.ts` | Subtree tombstone + deletion preview |
| `nodes/rollup.service.ts` | Subtree size/count aggregate |
| `access/access-context.ts` | `AccessContext` type |
| `access/share-token.ts` | Token generation + hashing |
| `access/access.resolver.ts` | The single access decision |
| `access/access.guard.ts` | Binds resolver to routes |
| `storage/storage.service.ts` | S3 presign PUT/GET, HEAD, DELETE |
| `uploads/uploads.service.ts` | presign + confirm |
| `uploads/pending-sweep.service.ts` | Hourly orphan cleanup |
| `files/versions.service.ts` | Version list + restore |
| `files/files.controller.ts` | `GET /nodes/:id/content` 302 |
| `shares/shares.service.ts` | Create/list/revoke |
| `shares/public-share.controller.ts` | `GET /shared/:token` |
| `search/search.service.ts` | Trigram name search inside scope |
| `seed/seed.ts` | Demo data |

---

### Task 1: Monorepo scaffold and local infrastructure

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.nvmrc`, `docker-compose.yml`, `.env.example`, `README.md`

**Interfaces:**
- Consumes: nothing
- Produces: root scripts `dev`, `build`, `test`, `lint`, `db:migrate`, `seed`, `openapi`; a local Postgres on `5433` and MinIO on `9000` (console `9001`) with bucket `data-room`

- [ ] **Step 1: Create the workspace root**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'apps/*'
```

`package.json`:
```json
{
  "name": "data-room-app",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "pnpm -r --parallel dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "db:migrate": "pnpm --filter api prisma migrate dev",
    "db:deploy": "pnpm --filter api prisma migrate deploy",
    "seed": "pnpm --filter api seed",
    "openapi": "pnpm --filter api openapi:emit && pnpm --filter web openapi:types",
    "infra:up": "docker compose up -d",
    "infra:down": "docker compose down -v"
  }
}
```

`.nvmrc`:
```
20
```

`.gitignore`:
```
node_modules/
dist/
build/
coverage/
.env
.env.local
.DS_Store
apps/api/openapi.json
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    # Loopback only: this stack ships default credentials, so it must not leave the machine.
    ports: ['127.0.0.1:5433:5432']
    environment:
      POSTGRES_USER: dataroom
      POSTGRES_PASSWORD: dataroom
      POSTGRES_DB: dataroom
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U dataroom']
      interval: 3s
      retries: 15
    volumes: ['pgdata:/var/lib/postgresql/data']

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    ports: ['127.0.0.1:9000:9000', '127.0.0.1:9001:9001']
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    healthcheck:
      test: ['CMD', 'mc', 'ready', 'local']
      interval: 3s
      retries: 15
    volumes: ['miniodata:/data']

  minio-init:
    image: minio/mc:latest
    depends_on:
      minio: { condition: service_healthy }
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 minioadmin minioadmin &&
      mc mb --ignore-existing local/data-room &&
      mc anonymous set none local/data-room &&
      echo minio-init-done"

volumes:
  pgdata:
  miniodata:
```

CORS on the local bucket is not configured here — MinIO allows all origins by default, which is what we want locally. Production bucket CORS is Task 3.

- [ ] **Step 3: Create `.env.example`**

```bash
# --- apps/api ---
DATABASE_URL="postgresql://dataroom:dataroom@localhost:5433/dataroom?schema=public"
JWT_SECRET="dev-jwt-secret-change-me"
REFRESH_SECRET="dev-refresh-secret-change-me"
PUBLIC_APP_URL="http://localhost:5173"
S3_ENDPOINT="http://localhost:9000"
S3_BUCKET="data-room"
S3_REGION="us-east-1"
S3_ACCESS_KEY_ID="minioadmin"
S3_SECRET_ACCESS_KEY="minioadmin"
S3_FORCE_PATH_STYLE="true"
# Optional — Google login is registered only when both are present
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""

# --- apps/web ---
VITE_API_BASE_URL="/api"
```

- [ ] **Step 4: Bring the infrastructure up and verify**

Run:
```bash
docker compose up -d
docker compose logs minio-init | grep minio-init-done
docker compose exec postgres pg_isready -U dataroom
```
Expected: `minio-init-done` in the logs, and `accepting connections` from `pg_isready`.

- [ ] **Step 5: Commit**

```bash
git init
git add .
git commit -m "chore: pnpm workspace scaffold with local Postgres and MinIO"
```

---

### Task 2: Nest skeleton with typed config, health check, and global error contract

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/nest-cli.json`, `apps/api/.eslintrc.cjs`, `apps/api/jest.config.js`
- Create: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`
- Create: `apps/api/src/config/env.ts`
- Create: `apps/api/src/common/errors.ts`
- Create: `apps/api/src/common/filters/domain-exception.filter.ts`
- Create: `apps/api/src/common/interceptors/bigint.interceptor.ts` (the Prisma filter moved to Task 4 — see below)
- Create: `apps/api/src/health/health.controller.ts`
- Test: `apps/api/src/config/env.spec.ts`, `apps/api/src/common/filters/domain-exception.filter.spec.ts`, `apps/api/src/common/interceptors/bigint.interceptor.spec.ts`, `apps/api/test/health.e2e-spec.ts`

**Interfaces:**
- Consumes: `.env.example` keys from Task 1
- Produces:
  - `DomainError` class and `ErrorCode` union — every later task throws these, never raw `HttpException`
  - `AppEnv` class (decorated with class-validator), `validateEnv(raw): AppEnv`, `googleEnabled(env)`
  - `GET /health` → `{ status: 'ok' }`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/config/env.spec.ts`:
```ts
import { googleEnabled, validateEnv } from './env'

const valid = {
  DATABASE_URL: 'postgresql://dataroom:dataroom@localhost:5433/dataroom?schema=public',
  JWT_SECRET: 'a'.repeat(16),
  REFRESH_SECRET: 'b'.repeat(16),
  PUBLIC_APP_URL: 'http://localhost:5173',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'data-room',
  S3_ACCESS_KEY_ID: 'minioadmin',
  S3_SECRET_ACCESS_KEY: 'minioadmin',
}

describe('validateEnv', () => {
  it('accepts a minimal environment and applies defaults', () => {
    const env = validateEnv(valid)
    expect(env.NODE_ENV).toBe('development')
    expect(env.PORT).toBe(3000)
    expect(env.S3_REGION).toBe('us-east-1')
    expect(env.S3_FORCE_PATH_STYLE).toBe(true)
  })

  it('accepts localhost urls, which have no TLD', () => {
    expect(() => validateEnv(valid)).not.toThrow()
  })

  it('coerces the string PORT into a number', () => {
    expect(validateEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080)
  })

  it('coerces S3_FORCE_PATH_STYLE into a real boolean', () => {
    expect(validateEnv({ ...valid, S3_FORCE_PATH_STYLE: 'false' }).S3_FORCE_PATH_STYLE).toBe(false)
    expect(validateEnv({ ...valid, S3_FORCE_PATH_STYLE: 'true' }).S3_FORCE_PATH_STYLE).toBe(true)
  })

  it('names the offending key when a required value is missing', () => {
    const { DATABASE_URL, ...withoutDb } = valid
    expect(() => validateEnv(withoutDb)).toThrow(/DATABASE_URL/)
  })

  it('rejects a database url that is not postgres', () => {
    expect(() => validateEnv({ ...valid, DATABASE_URL: 'mysql://localhost/db' })).toThrow(/DATABASE_URL/)
  })

  it('rejects a secret that is too short to be worth having', () => {
    expect(() => validateEnv({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/)
  })
})

describe('googleEnabled', () => {
  it('treats empty strings as absent, matching .env.example', () => {
    expect(googleEnabled({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' })).toBe(false)
  })

  it('requires both halves of the credential pair', () => {
    expect(googleEnabled({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: undefined })).toBe(false)
    expect(googleEnabled({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' })).toBe(true)
  })
})
```

`apps/api/src/common/filters/domain-exception.filter.spec.ts`:
```ts
import { DomainError } from '../errors'

describe('DomainError → HTTP status', () => {
  it.each([
    ['NOT_FOUND', 404],
    ['FORBIDDEN_ROLE', 403],
    ['GONE', 410],
    ['NAME_CONFLICT', 409],
    ['MOVE_CYCLE', 409],
    ['UPLOAD_NOT_FOUND', 409],
    ['TOO_LARGE', 413],
    ['UNSUPPORTED_TYPE', 415],
    ['VALIDATION', 422],
  ] as const)('maps %s to %i', (code, status) => {
    expect(new DomainError(code, 'msg').status).toBe(status)
  })

  it('carries a machine-readable code in the payload', () => {
    expect(new DomainError('NAME_CONFLICT', 'taken', { existingNodeId: 'n1' }).toPayload()).toEqual({
      code: 'NAME_CONFLICT',
      message: 'taken',
      details: { existingNodeId: 'n1' },
    })
  })
})
```

`apps/api/src/common/interceptors/bigint.interceptor.spec.ts`:
```ts
import { serializeBigInts } from './bigint.interceptor'

describe('serializeBigInts', () => {
  it('converts BigInt to number recursively', () => {
    expect(serializeBigInts({ a: 10n, b: [{ c: 2n }], d: 'x' })).toEqual({ a: 10, b: [{ c: 2 }], d: 'x' })
  })

  it('leaves Date instances intact', () => {
    const d = new Date('2026-01-01T00:00:00.000Z')
    expect(serializeBigInts({ d }).d).toBeInstanceOf(Date)
  })

  it('handles null and undefined', () => {
    expect(serializeBigInts({ a: null, b: undefined })).toEqual({ a: null, b: undefined })
  })
})
```

`apps/api/test/health.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'

describe('GET /health', () => {
  let app: INestApplication
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = mod.createNestApplication()
    await app.init()
  })
  afterAll(() => app.close())

  it('returns ok', async () => {
    await request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter api test`
Expected: FAIL — `Cannot find module './env'`, `Cannot find module '../errors'`, `Cannot find module '../src/app.module'`.

- [ ] **Step 3: Create the api package**

`apps/api/package.json`:
```json
{
  "name": "api",
  "private": true,
  "scripts": {
    "dev": "nest start --watch",
    "build": "nest build",
    "start": "node dist/main.js",
    "test": "jest",
    "test:e2e": "jest --config ./jest.e2e.config.js --runInBand",
    "lint": "eslint \"src/**/*.ts\"",
    "seed": "ts-node -r tsconfig-paths/register src/seed/seed.ts",
    "openapi:emit": "ts-node -r tsconfig-paths/register src/openapi.ts"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.658.0",
    "@aws-sdk/s3-request-presigner": "^3.658.0",
    "@nestjs/common": "^10.4.4",
    "@nestjs/config": "^3.2.3",
    "@nestjs/core": "^10.4.4",
    "@nestjs/jwt": "^10.2.0",
    "@nestjs/passport": "^10.0.3",
    "@nestjs/platform-express": "^10.4.4",
    "@nestjs/schedule": "^4.1.1",
    "@nestjs/swagger": "^7.4.2",
    "@prisma/client": "^5.20.0",
    "argon2": "^0.41.1",
    "class-transformer": "^0.5.1",
    "class-validator": "^0.14.1",
    "cookie-parser": "^1.4.7",
    "dotenv": "^16.4.5",
    "passport": "^0.7.0",
    "passport-google-oauth20": "^2.0.0",
    "passport-jwt": "^4.0.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.5",
    "@nestjs/testing": "^10.4.4",
    "@types/cookie-parser": "^1.4.7",
    "@types/express": "^5.0.0",
    "@types/jest": "^29.5.13",
    "@types/node": "^20.16.11",
    "@types/passport-google-oauth20": "^2.0.16",
    "@types/passport-jwt": "^4.0.1",
    "@types/supertest": "^6.0.2",
    "eslint": "^8.57.1",
    "jest": "^29.7.0",
    "pdf-lib": "^1.17.1",
    "prisma": "^5.20.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.2.5",
    "ts-node": "^10.9.2",
    "tsconfig-paths": "^4.2.0",
    "typescript": "^5.6.3"
  }
}
```

`apps/api/tsconfig.json`:
```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "baseUrl": "./",
    "declaration": false,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "strict": true,
    "strictPropertyInitialization": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*", "test/**/*"]
}
```

`apps/api/nest-cli.json`:
```json
{ "collection": "@nestjs/schematics", "sourceRoot": "src", "compilerOptions": { "deleteOutDir": true } }
```

`apps/api/jest.config.js`:
```js
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true }] },
  testRegex: 'src/.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
}
```

`apps/api/jest.e2e.config.js`:
```js
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true }] },
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 30000,
}
```

`apps/api/.eslintrc.cjs`:
```js
module.exports = {
  parser: '@typescript-eslint/parser',
  extends: ['eslint:recommended'],
  env: { node: true, es2022: true },
  parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
  rules: { 'no-unused-vars': 'off' },
}
```

- [ ] **Step 4: Implement config, errors, filters, interceptor, health**

`apps/api/src/config/env.ts`:
```ts
import { plainToInstance, Transform, Type } from 'class-transformer'
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, MinLength, validateSync } from 'class-validator'

/**
 * One validation library for the whole application: the same decorators that guard
 * request DTOs guard the environment.
 */
export class AppEnv {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development'

  @Type(() => Number)
  @IsInt()
  PORT = 3000

  // IsUrl rejects the postgresql:// scheme, so the shape is asserted directly.
  @Matches(/^postgres(ql)?:\/\/.+/, { message: 'must be a postgres connection string' })
  DATABASE_URL: string

  @IsString()
  @MinLength(16, { message: 'must be at least 16 characters' })
  JWT_SECRET: string

  @IsString()
  @MinLength(16, { message: 'must be at least 16 characters' })
  REFRESH_SECRET: string

  // require_tld: false — otherwise http://localhost:5173 fails validation in development.
  @IsUrl({ require_tld: false })
  PUBLIC_APP_URL: string

  @IsUrl({ require_tld: false })
  S3_ENDPOINT: string

  @IsString()
  @MinLength(1)
  S3_BUCKET: string

  @IsString()
  S3_REGION = 'us-east-1'

  @IsString()
  @MinLength(1)
  S3_ACCESS_KEY_ID: string

  @IsString()
  @MinLength(1)
  S3_SECRET_ACCESS_KEY: string

  // Env values are always strings; this is the only coercion that is not a number.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  S3_FORCE_PATH_STYLE = true

  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_ID?: string

  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_SECRET?: string
}

/** Fails fast at boot rather than at the first request that needs a missing key. */
export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const env = plainToInstance(AppEnv, raw, { exposeDefaultValues: true })
  const errors = validateSync(env, { skipMissingProperties: false })
  if (errors.length) {
    const detail = errors
      .map((error) => `  ${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('\n')
    throw new Error(`Invalid environment:\n${detail}`)
  }
  return env
}

/** An empty string counts as absent, which is how .env.example ships it. */
export const googleEnabled = (env: Pick<AppEnv, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>) =>
  Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
```

`validateEnv` returns the class instance, so `ConfigService` exposes only declared keys — a variable that is not in `AppEnv` is not readable through the typed getter. That is the intended behaviour: every configuration value the application uses is declared in one file.

`apps/api/src/common/errors.ts`:
```ts
export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN_ROLE'
  | 'GONE'
  | 'NAME_CONFLICT'
  | 'MOVE_CYCLE'
  | 'INVALID_TARGET'
  | 'UPLOAD_NOT_FOUND'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'VALIDATION'
  | 'INVALID_CREDENTIALS'

const STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  FORBIDDEN_ROLE: 403,
  GONE: 410,
  NAME_CONFLICT: 409,
  MOVE_CYCLE: 409,
  INVALID_TARGET: 409,
  UPLOAD_NOT_FOUND: 409,
  TOO_LARGE: 413,
  UNSUPPORTED_TYPE: 415,
  VALIDATION: 422,
  INVALID_CREDENTIALS: 401,
}

export class DomainError extends Error {
  readonly status: number
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.status = STATUS[code]
  }

  toPayload() {
    return { code: this.code, message: this.message, details: this.details }
  }
}

/** A node the caller may not see is reported as absent, never as forbidden. */
export const notFound = () => new DomainError('NOT_FOUND', 'Not found or you do not have access')
```

`apps/api/src/common/filters/domain-exception.filter.ts`:
```ts
import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common'
import { Response } from 'express'
import { DomainError } from '../errors'

@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: DomainError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>()
    res.status(error.status).json(error.toPayload())
  }
}
```

~~`apps/api/src/common/filters/prisma-exception.filter.ts`~~ — **moved to Task 4.** Under Prisma 7
the `@Catch()` argument (`Prisma.PrismaClientKnownRequestError`) lives in a generated client that
no schema has produced yet, and it is evaluated at import time. Task 2 issues no database query,
so nothing needs the mapping. Task 4 creates the file against a real generated client.

`apps/api/src/common/interceptors/bigint.interceptor.ts`:
```ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { map, Observable } from 'rxjs'

/**
 * Prisma returns BigInt for `sizeBytes`, and JSON.stringify throws on BigInt.
 * 2^53 bytes is 9 PB, so Number is lossless for any real file.
 */
export function serializeBigInts<T>(value: T): T {
  if (typeof value === 'bigint') return Number(value) as unknown as T
  if (value === null || value === undefined) return value
  if (value instanceof Date) return value
  if (Array.isArray(value)) return value.map(serializeBigInts) as unknown as T
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serializeBigInts(v)
    return out as T
  }
  return value
}

@Injectable()
export class BigIntInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(serializeBigInts))
  }
}
```

`apps/api/src/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Liveness probe used by the Railway healthcheck' })
  check() {
    return { status: 'ok' as const }
  }
}
```

`apps/api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { validateEnv } from './config/env'
import { HealthController } from './health/health.controller'

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })],
  controllers: [HealthController],
})
export class AppModule {}
```

`apps/api/src/swagger.ts` — a separate module on purpose: the openapi emitter in Plan 03 imports the document builder, and importing `main.ts` would start a server as a side effect.
```ts
import { DocumentBuilder } from '@nestjs/swagger'

export function buildSwagger() {
  return new DocumentBuilder()
    .setTitle('Data Room API')
    .setDescription('Owner-scoped document repository with read-only sharing')
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Share-Token' }, 'share-token')
    .build()
}
```

`apps/api/src/main.ts`:
```ts
// First import, deliberately: modules evaluated below read process.env at import time,
// before ConfigModule gets a chance to load apps/api/.env.
import 'dotenv/config'
import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { SwaggerModule } from '@nestjs/swagger'
import cookieParser from 'cookie-parser'
import { AppModule } from './app.module'
import { buildSwagger } from './swagger'
import { DomainExceptionFilter } from './common/filters/domain-exception.filter'
import { BigIntInterceptor } from './common/interceptors/bigint.interceptor'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.use(cookieParser())
  app.enableCors({
    origin: [process.env.PUBLIC_APP_URL!, 'http://localhost:5173'],
    credentials: true,
  })
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }))
  // Task 4 adds PrismaExceptionFilter ahead of this one, once a generated client exists.
  app.useGlobalFilters(new DomainExceptionFilter())
  app.useGlobalInterceptors(new BigIntInterceptor())
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, buildSwagger()))
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0')
}
void bootstrap()
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
pnpm install
pnpm --filter api test
pnpm --filter api test:e2e -- health
```
Expected: unit tests PASS; health e2e PASS.

- [ ] **Step 6: Verify Swagger renders**

Run: `cp .env.example apps/api/.env && pnpm --filter api dev`, then open `http://localhost:3000/docs`.
Expected: Swagger UI with the `health` tag and both security schemes listed.

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat(api): nest skeleton with typed env, error contract, health check, swagger"
```

---

### Task 3: Deploy both apps before writing features

Deployment goes first deliberately. The cross-site cookie problem and bucket CORS are environment failures that cannot be discovered locally, and discovering them in the eighth hour is not a plan.

**Files:**
- Create: `apps/web/package.json`, `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/tsconfig.json`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`
- Create: `vercel.json`
- Create: `apps/api/railway.json`

**Interfaces:**
- Consumes: `GET /health` from Task 2
- Produces: a live Railway API URL, a live Vercel URL, and a verified `GET <vercel>/api/health` proving the rewrite and first-party origin

- [ ] **Step 1: Create a minimal web app that calls the API through the rewrite**

`apps/web/package.json`:
```json
{
  "name": "web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "lint": "eslint \"src/**/*.{ts,tsx}\"",
    "openapi:types": "openapi-typescript ../api/openapi.json -o src/api/schema.d.ts"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.59.0",
    "@tanstack/react-virtual": "^3.10.8",
    "clsx": "^2.1.1",
    "lucide-react": "^0.451.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.27.0",
    "sonner": "^1.5.0",
    "tailwind-merge": "^2.5.3",
    "zustand": "^4.5.5"
  },
  "devDependencies": {
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.2",
    "autoprefixer": "^10.4.20",
    "eslint": "^8.57.1",
    "jsdom": "^25.0.1",
    "openapi-typescript": "^7.4.1",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.13",
    "typescript": "^5.6.3",
    "vite": "^5.4.8",
    "vitest": "^2.1.2"
  }
}
```

`apps/web/vite.config.ts`:
```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Mirrors the Vercel rewrite so local and production share one origin model.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  test: { environment: 'jsdom' },
})
```

`apps/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Data Room</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/App.tsx`:
```tsx
import { useEffect, useState } from 'react'

export default function App() {
  const [status, setStatus] = useState('checking…')
  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_BASE_URL}/health`)
      .then((r) => r.json())
      .then((d) => setStatus(`api: ${d.status}`))
      .catch((e) => setStatus(`api unreachable: ${String(e)}`))
  }, [])
  return <main style={{ fontFamily: 'system-ui', padding: 32 }}>{status}</main>
}
```

`apps/web/src/main.tsx`:
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

- [ ] **Step 2: Add the Vercel rewrite**

`vercel.json` at the repo root. Replace `<api-host>` with the Railway domain from Step 4.
```json
{
  "rewrites": [{ "source": "/api/:path*", "destination": "https://<api-host>/:path*" }]
}
```

`apps/api/railway.json`:
```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "deploy": {
    "startCommand": "node dist/main.js",
    "preDeployCommand": "npx prisma migrate deploy",
    "healthcheckPath": "/health",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

- [ ] **Step 3: Verify locally through the proxy first**

Run, in two terminals: `pnpm --filter api dev` and `pnpm --filter web dev`. Open `http://localhost:5173`.
Expected: the page reads `api: ok`, proving the `/api` prefix strip works before any cloud is involved.

- [ ] **Step 4: Provision Railway**

Use the Railway MCP tools (or `railway` CLI). Create: project `data-room`, a PostgreSQL database, a bucket named `data-room`, and a service from `apps/api` with root directory `apps/api` and watch path `apps/api/**`. Set variables from `.env.example`, with `DATABASE_URL` referencing the Postgres service and the `S3_*` values from the bucket credentials. Set `S3_FORCE_PATH_STYLE` per the bucket's addressing style. Generate a domain.

Verify: `curl https://<api-host>/health` → `{"status":"ok"}`, and `https://<api-host>/docs` renders.

- [ ] **Step 5: Configure the production bucket CORS**

The bucket must accept a browser `PUT` from the Vercel origin and expose `ETag`, or presigned upload fails in the browser while succeeding from curl.

```json
[
  {
    "AllowedOrigins": ["https://<vercel-host>", "http://localhost:5173"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Apply with the bucket's console or:
```bash
aws s3api put-bucket-cors --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" --cors-configuration file://cors.json
```

- [ ] **Step 6: Deploy the frontend to Vercel**

Import the repo. Root Directory `apps/web`. Build command `pnpm --filter web build`, install at repo root. Env `VITE_API_BASE_URL=/api`. Fill `<api-host>` in `vercel.json` and redeploy. Then set `PUBLIC_APP_URL` on Railway to the Vercel URL and redeploy the API.

- [ ] **Step 7: Verify the deployed round trip**

Run:
```bash
curl -s https://<vercel-host>/api/health
```
Expected: `{"status":"ok"}` — the rewrite works, so browser requests will be first-party and the refresh cookie can stay `SameSite=Lax`.

- [ ] **Step 8: Commit**

```bash
git add apps/web vercel.json apps/api/railway.json
git commit -m "chore: deploy api to railway and web to vercel behind an /api rewrite"
```

---

### Task 4: Prisma schema and the three raw SQL indexes

**Files:**
- Create: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma.config.ts`
- Create: `apps/api/prisma/migrations/<timestamp>_indexes/migration.sql` (hand-written, appended after `prisma migrate dev`)
- Create: `apps/api/src/prisma/prisma.service.ts`, `apps/api/src/prisma/prisma.module.ts`
- Create: `apps/api/src/common/filters/prisma-exception.filter.ts` (moved here from Task 2 — it needs the generated client)
- Modify: `apps/api/src/main.ts` (register the Prisma filter before `DomainExceptionFilter`), `apps/api/src/app.module.ts` (import `PrismaModule`), `apps/api/.gitignore` (ignore the generated client), `apps/api/eslint.config.mjs` (ignore the generated client)
- Test: `apps/api/test/schema-constraints.e2e-spec.ts`

**Interfaces:**
- Consumes: `DATABASE_URL`
- Produces: all Prisma models; `PrismaService` (extends the generated `PrismaClient`, exported by a global `PrismaModule`); the `node_name_uniq`, `node_path_prefix`, `node_name_trgm` indexes; `PrismaExceptionFilter` mapping `P2002` → 409 and `P2025` → 404

### Prisma 7 conventions this project uses

This repo has **Prisma 7.9.1**, which is not the Prisma 5 shape most examples show. Four differences are mandatory, all verified against the installed packages:

1. **`datasource` carries no `url`.** `url = env("DATABASE_URL")` in a schema file is a hard validation error (`P1012`). The URL lives in `prisma.config.ts` for Migrate, and reaches the client through a driver adapter.
2. **The generator is `prisma-client`, not `prisma-client-js`, and `output` is required.** It emits TypeScript sources (`client.ts`, `models/`, `enums.ts`, `internal/`) into that directory. This project generates into `src/generated/prisma`, inside `src` so that `nest build` emits it into `dist` with everything else.
3. **Imports come from the generated directory, never from `@prisma/client`.** `PrismaClient`, the model types, and the `Prisma` namespace (`Prisma.sql`, `Prisma.empty`, `Prisma.raw`, `Prisma.PrismaClientKnownRequestError`) all live in `src/generated/prisma/client`; enums live in `src/generated/prisma/enums`.
4. **The client needs an adapter.** Install `@prisma/adapter-pg` (it is not currently resolvable from `apps/api`, so add it explicitly; add `pg` and `@types/pg` too if the adapter requires them) and pass `new PrismaPg({ connectionString })` to the `PrismaClient` constructor.

The generated directory is build output: add `src/generated/` to `apps/api/.gitignore` and to the `ignores` array in `eslint.config.mjs`. Anyone cloning the repo runs `prisma generate` — which `postinstall` should do, so add `"postinstall": "prisma generate"` to `apps/api/package.json`.

- [ ] **Step 1: Write the failing test**

This test exists because `@@unique([parentId, name, deletedAt])` looks correct and silently enforces nothing: PostgreSQL treats NULLs in a unique index as distinct, so two live rows with `deleted_at = NULL` are not duplicates. The partial index is the fix, and this test is what proves it.

`apps/api/test/schema-constraints.e2e-spec.ts`:
```ts
import { PrismaPg } from '@prisma/adapter-pg'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '../src/generated/prisma/client'

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) })

async function makeRoom() {
  const user = await prisma.user.create({ data: { email: `u-${randomUUID()}@t.io`, name: 'T', passwordHash: 'x' } })
  const roomId = randomUUID()
  const rootId = randomUUID()
  await prisma.dataRoom.create({ data: { id: roomId, ownerId: user.id, name: 'R', rootNodeId: rootId } })
  await prisma.node.create({
    data: { id: rootId, roomId, type: 'FOLDER', name: 'R', path: '/', status: 'ACTIVE', createdById: user.id },
  })
  return { userId: user.id, roomId, rootId }
}

describe('schema constraints', () => {
  afterAll(() => prisma.$disconnect())

  it('rejects two live siblings with the same name', async () => {
    const { userId, roomId, rootId } = await makeRoom()
    const base = { roomId, parentId: rootId, type: 'FOLDER' as const, path: `/${rootId}/`, status: 'ACTIVE' as const, createdById: userId }
    await prisma.node.create({ data: { ...base, name: 'Financials' } })
    await expect(prisma.node.create({ data: { ...base, name: 'Financials' } })).rejects.toMatchObject({ code: 'P2002' })
  })

  it('treats names as case-insensitive for conflicts', async () => {
    const { userId, roomId, rootId } = await makeRoom()
    const base = { roomId, parentId: rootId, type: 'FILE' as const, path: `/${rootId}/`, status: 'ACTIVE' as const, createdById: userId }
    await prisma.node.create({ data: { ...base, name: 'Invoice.pdf' } })
    await expect(prisma.node.create({ data: { ...base, name: 'invoice.pdf' } })).rejects.toMatchObject({ code: 'P2002' })
  })

  it('allows reusing the name of a deleted sibling', async () => {
    const { userId, roomId, rootId } = await makeRoom()
    const base = { roomId, parentId: rootId, type: 'FILE' as const, path: `/${rootId}/`, status: 'ACTIVE' as const, createdById: userId }
    const first = await prisma.node.create({ data: { ...base, name: 'Deck.pdf' } })
    await prisma.node.update({ where: { id: first.id }, data: { deletedAt: new Date() } })
    await expect(prisma.node.create({ data: { ...base, name: 'Deck.pdf' } })).resolves.toBeDefined()
  })

  it('has the three hand-written indexes', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'Node'`
    const names = rows.map((r) => r.indexname)
    expect(names).toEqual(expect.arrayContaining(['node_name_uniq', 'node_path_prefix', 'node_name_trgm']))
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter api test:e2e -- schema-constraints`
Expected: FAIL — the Prisma client has no `node` model yet.

- [ ] **Step 3: Write the schema**

`apps/api/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

// No `url` here — Prisma 7 rejects it. Migrate reads it from prisma.config.ts;
// the client receives it through the driver adapter in PrismaService.
datasource db {
  provider = "postgresql"
}

enum NodeType   { FOLDER FILE }
enum NodeStatus { PENDING ACTIVE }
enum ShareMode  { PUBLIC_LINK USER }
enum Role       { VIEWER }

model User {
  id           String     @id @default(uuid())
  email        String     @unique
  passwordHash String?
  googleId     String?    @unique
  name         String
  createdAt    DateTime   @default(now())

  rooms        DataRoom[]
}

model DataRoom {
  id         String   @id @default(uuid())
  ownerId    String
  name       String
  rootNodeId String   @unique
  createdAt  DateTime @default(now())

  owner      User     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  nodes      Node[]

  @@index([ownerId, createdAt])
}

model Node {
  id               String        @id @default(uuid())
  roomId           String
  parentId         String?
  type             NodeType
  name             String
  path             String
  status           NodeStatus    @default(PENDING)
  currentVersionId String?       @unique
  sizeBytes        BigInt?
  deletedAt        DateTime?
  createdById      String
  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt

  room             DataRoom      @relation(fields: [roomId], references: [id], onDelete: Cascade)
  parent           Node?         @relation("NodeChildren", fields: [parentId], references: [id], onDelete: Cascade)
  children         Node[]        @relation("NodeChildren")
  versions         FileVersion[]
  shares           Share[]

  @@index([parentId, name, id])
  @@index([roomId, path])
  @@index([roomId, name])
  // Declared here, not only in raw SQL: Prisma's diff engine treats any index it cannot see in
  // the schema as drift and proposes dropping it, so an unaware `migrate dev` would silently
  // delete the trigram index the whole search feature depends on. `map:` must match the SQL name.
  @@index([name(ops: raw("gin_trgm_ops"))], type: Gin, map: "node_name_trgm")
  @@index([status, createdAt])
}

model FileVersion {
  id          String   @id @default(uuid())
  nodeId      String
  versionNo   Int
  blobKey     String
  sizeBytes   BigInt
  mimeType    String
  checksum    String?
  createdById String
  createdAt   DateTime @default(now())

  node        Node     @relation(fields: [nodeId], references: [id], onDelete: Cascade)

  @@unique([nodeId, versionNo])
}

model Share {
  id           String    @id @default(uuid())
  nodeId       String
  mode         ShareMode
  role         Role      @default(VIEWER)
  tokenHash    String?   @unique
  granteeEmail String?
  granteeId    String?
  createdById  String
  createdAt    DateTime  @default(now())
  revokedAt    DateTime?

  node         Node      @relation(fields: [nodeId], references: [id], onDelete: Cascade)

  @@unique([nodeId, granteeEmail])
  @@index([nodeId, revokedAt])
}
```

`DataRoom.nodes` cascades on delete, which only matters for hard deletion of a room in tests and seeds — user-facing deletion is the tombstone in Task 11.

- [ ] **Step 4: Generate the migration and append the raw SQL**

Run:
```bash
cp .env.example apps/api/.env   # if not already done
pnpm --filter api prisma migrate dev --name init
```

Migrate only finds the database through `prisma.config.ts`, so create it first.
`apps/api/prisma.config.ts`:
```ts
// dotenv first: this file is loaded by the Prisma CLI, which does not read .env for us.
import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // No `seed` entry yet — deliberately. Pointing it at a script that does not exist makes
    // `prisma migrate dev` hang waiting on a seed prompt with no TTY to answer it. Plan 06 adds
    // the entry in the same task that creates src/seed/seed.ts.
  },
  datasource: { url: env('DATABASE_URL') },
})
```

**Prisma 7 no longer generates the client as a side effect of `migrate dev`.** Run `prisma generate` explicitly after every schema change, including right after the initial migration — otherwise the imports in `PrismaService` and the tests resolve to a directory that does not exist yet.

**Destructive commands are gated for AI agents.** `migrate reset`, `db push --force-reset` and `db push --accept-data-loss` are blocked until the agent has explicit user consent, and the consent must not be inferred from earlier messages. This task never needs them: the database is empty and `migrate dev` on an empty database creates without destroying. If migration drift appears, escalate rather than resetting.

Then create a second migration for the three indexes Prisma cannot express:

```bash
pnpm --filter api prisma migrate dev --create-only --name indexes
```

Put this in the generated `migration.sql`:
```sql
-- Name uniqueness per folder, case-insensitive, ignoring tombstones.
-- A composite unique including deleted_at would enforce nothing: NULLs are distinct in PostgreSQL.
CREATE UNIQUE INDEX node_name_uniq ON "Node" ("parentId", lower(name)) WHERE "deletedAt" IS NULL;

-- Prefix LIKE only uses a btree index with an explicit pattern operator class.
CREATE INDEX node_path_prefix ON "Node" ("roomId", path varchar_pattern_ops);

-- Substring name search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX node_name_trgm ON "Node" USING gin (name gin_trgm_ops);
```

Run: `pnpm --filter api prisma migrate dev`

**Why only the trigram index is declared in the schema.** Verified with
`prisma migrate diff --from-config-datasource --to-schema`: with the GIN index declared, the diff
is empty. The other two raw indexes are invisible to Prisma's comparison rather than treated as
drift — it cannot represent a partial index at all, so `node_name_uniq`'s `WHERE "deletedAt" IS
NULL` is ignored, and it does not compare btree operator classes, so `node_path_prefix`'s
`varchar_pattern_ops` reads as a plain `@@index([roomId, path])` match. Do not try to "fix" those
two by declaring them; the SQL migration is their only home.

- [ ] **Step 5: Add PrismaService**

`apps/api/src/prisma/prisma.service.ts`:
```ts
import { INestApplication, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { AppEnv } from '../config/env'
import { PrismaClient } from '../generated/prisma/client'

/**
 * Prisma 7 reaches the database through a driver adapter rather than a `url` in the
 * schema, so the connection string is injected here from validated config — the same
 * value Migrate reads from prisma.config.ts.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService<AppEnv, true>) {
    super({ adapter: new PrismaPg({ connectionString: config.get('DATABASE_URL', { infer: true }) }) })
  }

  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }

  enableShutdownHooks(app: INestApplication) {
    process.on('beforeExit', () => void app.close())
  }
}
```

`onModuleDestroy` replaces the plan's earlier disconnect-free version: every e2e spec closes its Nest application, and a client left connected keeps Jest's event loop alive, which shows up as an open-handle warning — and test output must stay pristine.

`apps/api/src/prisma/prisma.module.ts`:
```ts
import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

Add `PrismaModule` to `AppModule.imports`.

- [ ] **Step 6: Add the Prisma exception filter (moved from Task 2)**

This file could not exist in Task 2: its `@Catch()` argument is evaluated at import time, and under Prisma 7 the error class lives in a generated client that no schema had produced yet. Now it exists.

`apps/api/src/common/filters/prisma-exception.filter.ts`:
```ts
import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common'
import { Response } from 'express'
import { Prisma } from '../../generated/prisma/client'

/**
 * The partial unique index on (parentId, lower(name)) is the authority on name
 * collisions, so a pre-check would race. We let the write fail and translate P2002.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(error: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>()
    if (error.code === 'P2002') {
      return res.status(409).json({ code: 'NAME_CONFLICT', message: 'An item with this name already exists here' })
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Not found or you do not have access' })
    }
    return res.status(500).json({ code: 'INTERNAL', message: 'Unexpected database error' })
  }
}
```

Register it in `apps/api/src/main.ts` ahead of the domain filter — Nest applies global filters right to left, so the more specific one must come first in the argument list:
```ts
app.useGlobalFilters(new PrismaExceptionFilter(), new DomainExceptionFilter())
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter api test:e2e -- schema-constraints`
Expected: all four PASS. If "allows reusing the name of a deleted sibling" fails, the index is not partial.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/src/prisma apps/api/src/app.module.ts apps/api/test
git commit -m "feat(api): prisma schema with partial unique, prefix and trigram indexes"
```

---

### Task 5: Email/password auth with access and refresh tokens

**Files:**
- Create: `apps/api/src/auth/auth.module.ts`, `auth.service.ts`, `auth.controller.ts`, `tokens.service.ts`
- Create: `apps/api/src/auth/dto/register.dto.ts`, `dto/login.dto.ts`
- Create: `apps/api/src/auth/strategies/jwt.strategy.ts`, `apps/api/src/auth/guards/jwt-auth.guard.ts`
- Create: `apps/api/src/auth/current-user.decorator.ts`
- Test: `apps/api/src/auth/auth.service.spec.ts`, `apps/api/test/auth.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `AppEnv`
- Produces:
  - `AuthUser = { id: string; email: string; name: string }`
  - `@CurrentUser() user: AuthUser` parameter decorator
  - `JwtAuthGuard` (throws 401)
  - `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`

- [ ] **Step 1: Write the failing tests**

`apps/api/src/auth/auth.service.spec.ts`:
```ts
import { AuthService } from './auth.service'
import { DomainError } from '../common/errors'
import * as argon2 from 'argon2'

const tokens = { signAccess: () => 'access-token', signRefresh: () => 'refresh-token' } as never

function makePrisma(user: unknown) {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      create: jest.fn().mockImplementation(({ data }: never) => Promise.resolve({ id: 'u1', ...data })),
    },
  } as never
}

describe('AuthService', () => {
  it('lower-cases the email on register so lookups are stable', async () => {
    const prisma = makePrisma(null)
    const svc = new AuthService(prisma, tokens)
    await svc.register({ email: 'MiXeD@Case.IO', password: 'password123', name: 'A' })
    expect((prisma as never as { user: { create: jest.Mock } }).user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'mixed@case.io' }) }),
    )
  })

  it('rejects a duplicate email with 409', async () => {
    const svc = new AuthService(makePrisma({ id: 'u1' }), tokens)
    await expect(svc.register({ email: 'a@b.io', password: 'password123', name: 'A' })).rejects.toBeInstanceOf(DomainError)
  })

  it('rejects a wrong password with INVALID_CREDENTIALS', async () => {
    const hash = await argon2.hash('correct-horse')
    const svc = new AuthService(makePrisma({ id: 'u1', email: 'a@b.io', name: 'A', passwordHash: hash }), tokens)
    await expect(svc.login({ email: 'a@b.io', password: 'wrong' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
  })

  it('rejects login for a Google-only account with no password set', async () => {
    const svc = new AuthService(makePrisma({ id: 'u1', email: 'a@b.io', name: 'A', passwordHash: null }), tokens)
    await expect(svc.login({ email: 'a@b.io', password: 'anything' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
  })
})
```

`apps/api/test/auth.e2e-spec.ts`:
```ts
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter'
import { randomUUID } from 'node:crypto'

describe('auth flow', () => {
  let app: INestApplication
  const email = `e2e-${randomUUID()}@t.io`

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = mod.createNestApplication()
    app.use(cookieParser())
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
  })
  afterAll(() => app.close())

  it('registers, then reads /auth/me with the access token', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123', name: 'E2E' })
      .expect(201)
    expect(reg.body.accessToken).toBeTruthy()
    expect(reg.headers['set-cookie'].join()).toMatch(/refresh_token=.*HttpOnly/i)

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${reg.body.accessToken}`)
      .expect(200)
      .expect((r) => expect(r.body.email).toBe(email))
  })

  it('rejects /auth/me without a token', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401)
  })

  it('rejects a short password with 400 from validation', async () => {
    await request(app.getHttpServer()).post('/auth/register').send({ email: 'x@y.io', password: 'short', name: 'X' }).expect(400)
  })

  it('exchanges the refresh cookie for a new access token', async () => {
    const login = await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'password123' }).expect(201)
    const cookie = login.headers['set-cookie']
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .expect(201)
      .expect((r) => expect(r.body.accessToken).toBeTruthy())
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter api test -- auth` and `pnpm --filter api test:e2e -- auth`
Expected: FAIL — `Cannot find module './auth.service'`, and 404 on `/auth/register`.

- [ ] **Step 3: Implement tokens, service, controller, guard**

`apps/api/src/auth/tokens.service.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import { Response } from 'express'
import { AppEnv } from '../config/env'

export const REFRESH_COOKIE = 'refresh_token'

@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  signAccess(sub: string) {
    return this.jwt.sign({ sub }, { secret: this.config.get('JWT_SECRET', { infer: true }), expiresIn: '15m' })
  }

  signRefresh(sub: string) {
    return this.jwt.sign({ sub }, { secret: this.config.get('REFRESH_SECRET', { infer: true }), expiresIn: '7d' })
  }

  verifyRefresh(token: string): { sub: string } {
    return this.jwt.verify(token, { secret: this.config.get('REFRESH_SECRET', { infer: true }) })
  }

  /**
   * SameSite=Lax is safe because the browser always reaches the API through the
   * Vercel /api rewrite, making every request first-party.
   */
  setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.config.get('NODE_ENV', { infer: true }) === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
  }

  clearRefreshCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, { path: '/' })
  }
}
```

`apps/api/src/auth/dto/register.dto.ts`:
```ts
import { ApiProperty } from '@nestjs/swagger'
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator'

export class RegisterDto {
  @ApiProperty({ example: 'analyst@acme.io' })
  @IsEmail()
  email: string

  @ApiProperty({ minLength: 8, example: 'password123' })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string

  @ApiProperty({ example: 'Dana Analyst' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string
}
```

`apps/api/src/auth/dto/login.dto.ts`:
```ts
import { ApiProperty } from '@nestjs/swagger'
import { IsEmail, IsString } from 'class-validator'

export class LoginDto {
  @ApiProperty({ example: 'demo@dataroom.app' })
  @IsEmail()
  email: string

  @ApiProperty({ example: 'demo1234' })
  @IsString()
  password: string
}
```

`apps/api/src/auth/auth.service.ts`:
```ts
import { Injectable } from '@nestjs/common'
import * as argon2 from 'argon2'
import { PrismaService } from '../prisma/prisma.service'
import { DomainError } from '../common/errors'
import { TokensService } from './tokens.service'
import { RegisterDto } from './dto/register.dto'
import { LoginDto } from './dto/login.dto'

export type AuthUser = { id: string; email: string; name: string }

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase()
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new DomainError('NAME_CONFLICT', 'An account with this email already exists')
    }
    const user = await this.prisma.user.create({
      data: { email, name: dto.name, passwordHash: await argon2.hash(dto.password) },
    })
    return this.issue(user)
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } })
    // One message for "no such user" and "wrong password" — no account enumeration.
    if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, dto.password))) {
      throw new DomainError('INVALID_CREDENTIALS', 'Incorrect email or password')
    }
    return this.issue(user)
  }

  async refresh(refreshToken: string | undefined) {
    if (!refreshToken) throw new DomainError('INVALID_CREDENTIALS', 'Missing refresh token')
    let sub: string
    try {
      sub = this.tokens.verifyRefresh(refreshToken).sub
    } catch {
      throw new DomainError('INVALID_CREDENTIALS', 'Expired or invalid refresh token')
    }
    const user = await this.prisma.user.findUnique({ where: { id: sub } })
    if (!user) throw new DomainError('INVALID_CREDENTIALS', 'Unknown account')
    return this.issue(user)
  }

  async upsertGoogleUser(profile: { googleId: string; email: string; name: string }) {
    const email = profile.email.toLowerCase()
    const existing = await this.prisma.user.findFirst({ where: { OR: [{ googleId: profile.googleId }, { email }] } })
    const user = existing
      ? await this.prisma.user.update({ where: { id: existing.id }, data: { googleId: profile.googleId } })
      : await this.prisma.user.create({ data: { email, name: profile.name, googleId: profile.googleId } })
    return this.issue(user)
  }

  private issue(user: { id: string; email: string; name: string }) {
    return {
      user: { id: user.id, email: user.email, name: user.name } satisfies AuthUser,
      accessToken: this.tokens.signAccess(user.id),
      refreshToken: this.tokens.signRefresh(user.id),
    }
  }
}
```

`apps/api/src/auth/strategies/jwt.strategy.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { AppEnv } from '../../config/env'
import { PrismaService } from '../../prisma/prisma.service'
import { DomainError } from '../../common/errors'
import { AuthUser } from '../auth.service'

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<AppEnv, true>,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req) => req?.cookies?.access_token ?? null,
      ]),
      secretOrKey: config.get('JWT_SECRET', { infer: true }),
    })
  }

  async validate(payload: { sub: string }): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } })
    if (!user) throw new DomainError('INVALID_CREDENTIALS', 'Unknown account')
    return { id: user.id, email: user.email, name: user.name }
  }
}
```

`apps/api/src/auth/guards/jwt-auth.guard.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

`apps/api/src/auth/current-user.decorator.ts`:
```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import { AuthUser } from './auth.service'

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
)
```

`apps/api/src/auth/auth.controller.ts`:
```ts
import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Request, Response } from 'express'
import { AuthService, AuthUser } from './auth.service'
import { RegisterDto } from './dto/register.dto'
import { LoginDto } from './dto/login.dto'
import { REFRESH_COOKIE, TokensService } from './tokens.service'
import { JwtAuthGuard } from './guards/jwt-auth.guard'
import { CurrentUser } from './current-user.decorator'

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
  ) {}

  @Post('register')
  @ApiOperation({ summary: 'Create an account' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const { user, accessToken, refreshToken } = await this.auth.register(dto)
    this.tokens.setRefreshCookie(res, refreshToken)
    return { user, accessToken }
  }

  @Post('login')
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiResponse({ status: 401, description: 'Incorrect email or password' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { user, accessToken, refreshToken } = await this.auth.login(dto)
    this.tokens.setRefreshCookie(res, refreshToken)
    return { user, accessToken }
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Exchange the refresh cookie for a new access token' })
  @ApiResponse({ status: 401, description: 'Missing, expired or invalid refresh token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user, accessToken, refreshToken } = await this.auth.refresh(req.cookies?.[REFRESH_COOKIE])
    this.tokens.setRefreshCookie(res, refreshToken)
    return { user, accessToken }
  }

  @Post('logout')
  @ApiOperation({ summary: 'Clear the refresh cookie' })
  logout(@Res({ passthrough: true }) res: Response) {
    this.tokens.clearRefreshCookie(res)
    return { ok: true }
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Current session' })
  @ApiResponse({ status: 401, description: 'Not signed in' })
  me(@CurrentUser() user: AuthUser) {
    return user
  }
}
```

`apps/api/src/auth/auth.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { AuthService } from './auth.service'
import { AuthController } from './auth.controller'
import { TokensService } from './tokens.service'
import { JwtStrategy } from './strategies/jwt.strategy'

@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, TokensService, JwtStrategy],
  exports: [AuthService, TokensService],
})
export class AuthModule {}
```

Add `AuthModule` to `AppModule.imports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter api test -- auth` then `pnpm --filter api test:e2e -- auth`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth apps/api/test/auth.e2e-spec.ts apps/api/src/app.module.ts
git commit -m "feat(api): email/password auth with access token and refresh cookie"
```

---

### Task 6: Google OAuth, registered only when configured

**Files:**
- Create: `apps/api/src/auth/strategies/google.strategy.ts`
- Create: `apps/api/src/auth/google.controller.ts`
- Modify: `apps/api/src/auth/auth.module.ts`
- Test: `apps/api/src/auth/google-registration.spec.ts`

**Interfaces:**
- Consumes: `AuthService.upsertGoogleUser` from Task 5, `googleEnabled` from Task 2
- Produces: `GET /auth/google`, `GET /auth/google/callback` — present only when both Google env vars are set

- [ ] **Step 1: Write the failing test**

`apps/api/src/auth/google-registration.spec.ts`:
```ts
import { googleEnabled } from '../config/env'
import { googleProviders } from './auth.module'

describe('Google strategy registration', () => {
  it('is disabled when credentials are absent, so the app still boots', () => {
    const env = { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }
    expect(googleEnabled(env)).toBe(false)
    expect(googleProviders(env)).toHaveLength(0)
  })

  it('is enabled only when both variables are present', () => {
    expect(googleEnabled({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: undefined })).toBe(false)
    expect(googleProviders({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' })).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter api test -- google-registration`
Expected: FAIL — `googleProviders` is not exported from `auth.module`.

- [ ] **Step 3: Implement the strategy and the conditional provider**

`apps/api/src/auth/strategies/google.strategy.ts`:
```ts
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import { Profile, Strategy } from 'passport-google-oauth20'
import { AppEnv } from '../../config/env'

export type GoogleProfile = { googleId: string; email: string; name: string }

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService<AppEnv, true>) {
    super({
      clientID: config.get('GOOGLE_CLIENT_ID', { infer: true })!,
      clientSecret: config.get('GOOGLE_CLIENT_SECRET', { infer: true })!,
      callbackURL: `${config.get('PUBLIC_APP_URL', { infer: true })}/api/auth/google/callback`,
      scope: ['email', 'profile'],
    })
  }

  validate(_at: string, _rt: string, profile: Profile): GoogleProfile {
    return {
      googleId: profile.id,
      email: profile.emails?.[0]?.value ?? '',
      name: profile.displayName ?? profile.emails?.[0]?.value ?? 'User',
    }
  }
}
```

`apps/api/src/auth/google.controller.ts`:
```ts
import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ConfigService } from '@nestjs/config'
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Request, Response } from 'express'
import { AppEnv } from '../config/env'
import { AuthService } from './auth.service'
import { TokensService } from './tokens.service'
import { GoogleProfile } from './strategies/google.strategy'

@ApiTags('auth')
@Controller('auth/google')
export class GoogleController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  @Get()
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Start Google sign-in (redirects to Google)' })
  start() {
    /* Passport redirects. */
  }

  @Get('callback')
  @UseGuards(AuthGuard('google'))
  @ApiExcludeEndpoint()
  async callback(@Req() req: Request, @Res() res: Response) {
    const { accessToken, refreshToken } = await this.auth.upsertGoogleUser(req.user as GoogleProfile)
    this.tokens.setRefreshCookie(res, refreshToken)
    // The SPA reads the access token from the fragment, then replaces history.
    res.redirect(`${this.config.get('PUBLIC_APP_URL', { infer: true })}/auth/callback#access_token=${accessToken}`)
  }
}
```

Modify `apps/api/src/auth/auth.module.ts`:
```ts
import { Module, Provider } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { AppEnv, googleEnabled } from '../config/env'
import { AuthService } from './auth.service'
import { AuthController } from './auth.controller'
import { GoogleController } from './google.controller'
import { TokensService } from './tokens.service'
import { JwtStrategy } from './strategies/jwt.strategy'
import { GoogleStrategy } from './strategies/google.strategy'

/** Exported for the unit test: the strategy must not be constructed without credentials. */
export function googleProviders(env: Pick<AppEnv, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>): Provider[] {
  return googleEnabled(env) ? [GoogleStrategy] : []
}

/**
 * Gated on raw `process.env`, not on `validateEnv`: this line runs at import time,
 * before `ConfigModule` loads `apps/api/.env`. `main.ts` imports `dotenv/config` as its
 * first statement, so the file is already in `process.env` by the time this module is
 * evaluated. Full validation still happens in `ConfigModule.forRoot({ validate: validateEnv })`.
 */
const googleConfigured = googleEnabled(process.env)

@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: googleConfigured ? [AuthController, GoogleController] : [AuthController],
  providers: [AuthService, TokensService, JwtStrategy, ...googleProviders(process.env)],
  exports: [AuthService, TokensService],
})
export class AuthModule {}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter api test -- google-registration`
Expected: PASS.

- [ ] **Step 5: Verify the app still boots without Google credentials**

Run: `pnpm --filter api dev` with `GOOGLE_CLIENT_ID=""` in `apps/api/.env`, then `curl localhost:3000/health` and `curl -i localhost:3000/auth/google`.
Expected: `/health` is 200; `/auth/google` is 404 — the route simply does not exist.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth
git commit -m "feat(api): optional google oauth, registered only when configured"
```

---
