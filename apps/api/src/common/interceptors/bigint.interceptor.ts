import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common'
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
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = serializeBigInts(v)
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
