import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator'
import { Type } from 'class-transformer'

export class SearchQueryDto {
  /**
   * Two characters is the floor because a one-character `%a%` matches most of a room
   * and cannot use the trigram index (a trigram is three characters), so it degrades
   * to a sequential scan for a result nobody wants.
   */
  @ApiProperty({ minLength: 2, example: 'audit' })
  @IsString()
  @MinLength(2)
  q: string

  @ApiPropertyOptional({
    description:
      'Folder to search within; defaults to the caller scope root. A share viewer passes the shared node here',
  })
  @IsOptional()
  @IsString()
  parentId?: string

  @ApiPropertyOptional({ description: 'Keyset cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string

  @ApiPropertyOptional({ default: 25, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number
}
