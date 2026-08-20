import { describe, expect, it } from 'vitest'
import { formatBytes } from './format'

describe('formatBytes', () => {
  it('renders zero without a fraction', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('uses binary units', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
  })

  it('keeps one decimal at most', () => {
    expect(formatBytes(1_234_567)).toBe('1.2 MB')
  })
})
