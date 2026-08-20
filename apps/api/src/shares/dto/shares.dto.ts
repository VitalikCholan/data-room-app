import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsEmail, IsIn, ValidateIf } from 'class-validator'

export class CreateShareDto {
  @ApiProperty({ enum: ['PUBLIC_LINK', 'USER'] })
  @IsIn(['PUBLIC_LINK', 'USER'])
  mode: 'PUBLIC_LINK' | 'USER'

  @ApiPropertyOptional({
    description:
      'Required for mode USER; may be an address with no account yet',
  })
  @ValidateIf((o: CreateShareDto) => o.mode === 'USER')
  @IsEmail()
  email?: string
}
