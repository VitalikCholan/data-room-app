import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'
import { Type } from 'class-transformer'

/**
 * Slashes would corrupt path arithmetic; control characters break the cursor.
 * The control-character range is intentional, not accidental — disable the rule
 * rather than the check.
 */
// eslint-disable-next-line no-control-regex
const SAFE_NAME = /^[^/\\\x00-\x1f]+$/

export class NodeNameDto {
  @ApiProperty({ example: 'Financials' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(SAFE_NAME, {
    message: 'name must not contain slashes or control characters',
  })
  name: string
}

export class CreateFolderDto extends NodeNameDto {
  @ApiProperty({
    description: 'Parent folder id; the room root id for a top-level folder',
  })
  @IsString()
  parentId: string
}

export class RenameNodeDto extends NodeNameDto {}

export class MoveNodeDto {
  @ApiProperty({ description: 'Destination folder id' })
  @IsString()
  targetParentId: string
}

export class ListNodesQueryDto {
  @ApiPropertyOptional({
    description: 'Folder to list; defaults to the room root',
  })
  @IsOptional()
  @IsString()
  parentId?: string

  @ApiPropertyOptional({ description: 'Keyset cursor from a previous page' })
  @IsOptional()
  @IsString()
  cursor?: string

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number

  @ApiPropertyOptional({ enum: ['name', 'updatedAt', 'size'], default: 'name' })
  @IsOptional()
  @IsIn(['name', 'updatedAt', 'size'])
  sort?: 'name' | 'updatedAt' | 'size'
}
