import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsIn,
  IsInt,
  IsMimeType,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'

/**
 * Slashes would corrupt path arithmetic; control characters break the cursor.
 * The control-character range is intentional, not accidental — disable the rule
 * rather than the check.
 */
// eslint-disable-next-line no-control-regex
const SAFE_NAME = /^[^/\\\x00-\x1f]+$/

export class PresignUploadDto {
  @ApiProperty()
  @IsString()
  parentId: string

  @ApiProperty({ example: 'FY23 Audit.pdf' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(SAFE_NAME, {
    message: 'name must not contain slashes or control characters',
  })
  name: string

  @ApiProperty({
    description: 'Client-reported size; re-read from the bucket on confirm',
  })
  @IsInt()
  @Min(1)
  sizeBytes: number

  @ApiProperty({ example: 'application/pdf' })
  @IsMimeType()
  mimeType: string

  @ApiPropertyOptional({
    enum: ['NEW_VERSION', 'KEEP_BOTH'],
    description:
      'Omit to receive 409 NAME_CONFLICT and let the user choose. NEW_VERSION is only valid when the name is held by a file — a folder cannot be versioned (409 NOT_VERSIONABLE)',
  })
  @IsOptional()
  @IsIn(['NEW_VERSION', 'KEEP_BOTH'])
  onConflict?: 'NEW_VERSION' | 'KEEP_BOTH'
}

export class ConfirmUploadDto {
  @ApiProperty({ description: 'Version id returned by presign' })
  @IsString()
  versionId: string
}
