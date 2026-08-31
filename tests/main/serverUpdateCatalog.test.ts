import { describe, expect, it } from 'vitest'
import { resolveUpdateChannel } from '../../src/shared/updateChannel'

describe('resolveUpdateChannel', () => {
  it('keeps regular releases on the stable channel by default', () => {
    expect(resolveUpdateChannel('3.1.0')).toBe('stable')
  })

  it('lets regular releases opt in to beta updates', () => {
    expect(resolveUpdateChannel('3.1.0', true)).toBe('beta')
  })

  it('keeps prerelease builds on the beta channel regardless of preference', () => {
    expect(resolveUpdateChannel('3.1.0-beta.2', false)).toBe('beta')
  })
})
