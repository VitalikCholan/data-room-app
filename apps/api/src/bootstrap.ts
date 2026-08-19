import { INestApplication, ValidationPipe } from '@nestjs/common'
import type { ValidationError } from '@nestjs/common'
import cookieParser from 'cookie-parser'
import { DomainError } from './common/errors'
import { DomainExceptionFilter } from './common/filters/domain-exception.filter'
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter'
import { BigIntInterceptor } from './common/interceptors/bigint.interceptor'

/**
 * class-validator returns a tree (nested `children` for nested DTOs); this flattens it
 * into `{ "field.nested": ["message", ...] }` so the error envelope's `details` stays a
 * flat, predictable shape for clients regardless of DTO nesting depth.
 */
export function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): Record<string, string[]> {
  const details: Record<string, string[]> = {}
  for (const error of errors) {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property
    if (error.constraints) {
      details[path] = Object.values(error.constraints)
    }
    if (error.children?.length) {
      Object.assign(details, flattenValidationErrors(error.children, path))
    }
  }
  return details
}

/**
 * Applies every piece of app-behaviour wiring that must be identical between production
 * and tests: the global validation pipe, both exception filters (in the order they must
 * run — the more specific Prisma filter first), and the BigInt interceptor. CORS and
 * Swagger stay out of this function on purpose — they are server concerns (which origins,
 * which port serves docs), not app-behaviour concerns that a test would need to reproduce.
 *
 * A pure function with no side effects at import time, for the same reason `swagger.ts`
 * is kept separate from `main.ts`: both production and every e2e spec call it directly.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.use(cookieParser())
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors) =>
        new DomainError('VALIDATION', 'Validation failed', {
          fields: flattenValidationErrors(errors),
        }),
    }),
  )
  // Global filters apply right to left, so the more specific Prisma filter must come
  // first — it needs first refusal on Prisma errors before the domain filter runs.
  app.useGlobalFilters(new PrismaExceptionFilter(), new DomainExceptionFilter())
  app.useGlobalInterceptors(new BigIntInterceptor())
  return app
}
