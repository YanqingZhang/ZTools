import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEARCH_WALLPAPER_BLUR,
  DEFAULT_SEARCH_WALLPAPER_OPACITY,
  normalizeSearchWallpaperConfig
} from '@shared/searchWallpaper'

describe('normalizeSearchWallpaperConfig', () => {
  it('accepts a local file URL and keeps valid effect values', () => {
    expect(
      normalizeSearchWallpaperConfig({
        path: '/Users/example/My Wallpaper.jpg',
        url: 'file:///Users/example/My%20Wallpaper.jpg',
        opacity: 0.6,
        blur: 8
      })
    ).toEqual({
      path: '/Users/example/My Wallpaper.jpg',
      url: 'file:///Users/example/My%20Wallpaper.jpg',
      opacity: 0.6,
      blur: 8
    })
  })

  it('returns a cloneable plain object when the source is a reactive-style proxy', () => {
    const proxiedWallpaper = new Proxy(
      {
        path: '/Users/example/background.png',
        url: 'file:///Users/example/background.png',
        opacity: 0.45,
        blur: 4
      },
      {}
    )

    const normalizedWallpaper = normalizeSearchWallpaperConfig(proxiedWallpaper)

    expect(() => structuredClone(normalizedWallpaper)).not.toThrow()
    expect(normalizedWallpaper).toEqual({
      path: '/Users/example/background.png',
      url: 'file:///Users/example/background.png',
      opacity: 0.45,
      blur: 4
    })
  })

  it('uses defaults and clamps effect values to supported ranges', () => {
    expect(
      normalizeSearchWallpaperConfig({
        path: 'C:\\Wallpapers\\background.png',
        url: 'file:///C:/Wallpapers/background.png',
        opacity: 3,
        blur: -5
      })
    ).toEqual({
      path: 'C:\\Wallpapers\\background.png',
      url: 'file:///C:/Wallpapers/background.png',
      opacity: 1,
      blur: 0
    })

    expect(
      normalizeSearchWallpaperConfig({
        path: '/tmp/background.png',
        url: 'file:///tmp/background.png'
      })
    ).toMatchObject({
      opacity: DEFAULT_SEARCH_WALLPAPER_OPACITY,
      blur: DEFAULT_SEARCH_WALLPAPER_BLUR
    })
  })

  it('rejects empty paths and non-local URLs', () => {
    expect(normalizeSearchWallpaperConfig(null)).toBeNull()
    expect(normalizeSearchWallpaperConfig({ path: '', url: 'file:///tmp/a.png' })).toBeNull()
    expect(
      normalizeSearchWallpaperConfig({
        path: '/tmp/a.png',
        url: 'https://example.com/a.png'
      })
    ).toBeNull()
  })
})
