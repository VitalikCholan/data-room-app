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
