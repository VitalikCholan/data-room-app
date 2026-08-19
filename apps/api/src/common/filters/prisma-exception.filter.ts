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
      return res.status(409).json({
        code: 'NAME_CONFLICT',
        message: 'An item with this name already exists here',
      })
    }
    if (error.code === 'P2025') {
      return res.status(404).json({
        code: 'NOT_FOUND',
        message: 'Not found or you do not have access',
      })
    }
    return res
      .status(500)
      .json({ code: 'INTERNAL', message: 'Unexpected database error' })
  }
}
