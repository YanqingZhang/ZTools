import { describe, expect, it } from 'vitest'
import {
  mergeMacUpdateMetadata,
  selectMacUpdateZip,
  withReleaseNotes
} from '../../scripts/update-metadata.mjs'

const x64Metadata = {
  version: '3.0.0-beta.9',
  files: [
    { url: 'ZTools-3.0.0-beta.9-mac-x64.dmg', sha512: 'dmg-x64' },
    { url: 'ZTools-3.0.0-beta.9-mac-x64.zip', sha512: 'zip-x64', size: 100 }
  ],
  path: 'ZTools-3.0.0-beta.9-mac-x64.zip',
  sha512: 'zip-x64',
  releaseDate: '2026-07-20T00:00:00.000Z'
}

const arm64Metadata = {
  version: '3.0.0-beta.9',
  files: [{ url: 'ZTools-3.0.0-beta.9-mac-arm64.zip', sha512: 'zip-arm64', size: 90 }],
  releaseDate: '2026-07-20T00:00:01.000Z'
}

describe('macOS update metadata', () => {
  it('selects the standard full app zip for the requested architecture', () => {
    expect(selectMacUpdateZip(x64Metadata, 'x64')).toMatchObject({
      url: 'ZTools-3.0.0-beta.9-mac-x64.zip',
      sha512: 'zip-x64'
    })
  })

  it('merges x64 and arm64 full app zips and preserves checksums', () => {
    const merged = mergeMacUpdateMetadata(x64Metadata, arm64Metadata, 'release notes')

    expect(merged.files).toEqual([
      { url: 'ZTools-3.0.0-beta.9-mac-x64.zip', sha512: 'zip-x64', size: 100 },
      { url: 'ZTools-3.0.0-beta.9-mac-arm64.zip', sha512: 'zip-arm64', size: 90 }
    ])
    expect(merged.path).toBe('ZTools-3.0.0-beta.9-mac-x64.zip')
    expect(merged.sha512).toBe('zip-x64')
    expect(merged.releaseNotes).toBe('release notes')
    expect(merged).not.toHaveProperty('changelog')
  })

  it('rejects metadata from different versions', () => {
    expect(() =>
      mergeMacUpdateMetadata(x64Metadata, { ...arm64Metadata, version: '3.0.1' }, '')
    ).toThrow('版本不一致')
  })

  it('rejects a standard zip without SHA-512', () => {
    expect(() =>
      selectMacUpdateZip(
        {
          ...arm64Metadata,
          files: [{ url: 'ZTools-3.0.0-beta.9-mac-arm64.zip' }]
        },
        'arm64'
      )
    ).toThrow('缺少 SHA-512')
  })
})

describe('Windows update metadata', () => {
  it('adds release notes without rewriting electron-builder metadata', () => {
    const normalized = withReleaseNotes(
      {
        version: '3.0.0-beta.9',
        files: [{ url: 'ZTools-3.0.0-beta.9-win-x64-setup.exe', sha512: 'setup-sha512' }],
        path: 'ZTools-3.0.0-beta.9-win-x64-setup.exe',
        sha512: 'setup-sha512',
        releaseDate: '2026-07-20T00:00:00.000Z'
      },
      'release notes'
    )

    expect(normalized.files[0].sha512).toBe('setup-sha512')
    expect(normalized.path).toBe('ZTools-3.0.0-beta.9-win-x64-setup.exe')
    expect(normalized.sha512).toBe('setup-sha512')
    expect(normalized.releaseNotes).toBe('release notes')
    expect(normalized).not.toHaveProperty('changelog')
  })
})
