import { ApiProperty } from '@nestjs/swagger'
import { IsString, MaxLength, MinLength } from 'class-validator'

export class CreateRoomDto {
  @ApiProperty({ example: 'Project Titan — Acme Acquisition' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string
}

export class RenameRoomDto extends CreateRoomDto {}
