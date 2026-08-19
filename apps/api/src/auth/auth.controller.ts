import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import type { Request, Response } from 'express'
import { AuthService } from './auth.service'
import type { AuthUser } from './auth.service'
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
  @ApiResponse({ status: 422, description: 'Validation failed' })
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, accessToken, refreshToken } = await this.auth.register(dto)
    this.tokens.setRefreshCookie(res, refreshToken)
    return { user, accessToken }
  }

  @Post('login')
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiResponse({ status: 401, description: 'Incorrect email or password' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, accessToken, refreshToken } = await this.auth.login(dto)
    this.tokens.setRefreshCookie(res, refreshToken)
    return { user, accessToken }
  }

  @Post('refresh')
  @ApiOperation({
    summary: 'Exchange the refresh cookie for a new access token',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing, expired or invalid refresh token',
  })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const incoming = req.cookies?.[REFRESH_COOKIE] as string | undefined
    const { user, accessToken, refreshToken } =
      await this.auth.refresh(incoming)
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
    // Matches register/login/refresh's `{ user, ... }` envelope: a flat user body here
    // was the odd one out, and that shape freezes as soon as openapi.json is emitted.
    return { user }
  }
}
