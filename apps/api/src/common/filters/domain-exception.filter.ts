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
