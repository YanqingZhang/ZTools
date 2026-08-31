export interface SearchWallpaperConfig {
  path: string
  url: string
  opacity: number
  blur: number
}

export const DEFAULT_SEARCH_WALLPAPER_OPACITY = 0.35
export const DEFAULT_SEARCH_WALLPAPER_BLUR = 0

/**
 * 将数值限制在壁纸配置允许的范围内。
 * @param value 待限制的原始值
 * @param fallback 原始值无效时使用的默认值
 * @param min 允许的最小值
 * @param max 允许的最大值
 * @returns 已限制到指定范围的数值
 */
function clampWallpaperNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) return fallback
  return Math.min(max, Math.max(min, numericValue))
}

/**
 * 规范化主搜索窗口壁纸配置，过滤无效路径和非本地 URL。
 * @param value 从持久化存储或 IPC 接收的原始配置
 * @returns 可安全用于渲染的壁纸配置；无有效壁纸时返回 null
 */
export function normalizeSearchWallpaperConfig(value: unknown): SearchWallpaperConfig | null {
  if (!value || typeof value !== 'object') return null

  const candidate = value as Partial<SearchWallpaperConfig>
  const path = typeof candidate.path === 'string' ? candidate.path.trim() : ''
  const url = typeof candidate.url === 'string' ? candidate.url.trim() : ''
  if (!path || !url.startsWith('file:')) return null

  return {
    path,
    url,
    opacity: clampWallpaperNumber(candidate.opacity, DEFAULT_SEARCH_WALLPAPER_OPACITY, 0.05, 1),
    blur: clampWallpaperNumber(candidate.blur, DEFAULT_SEARCH_WALLPAPER_BLUR, 0, 20)
  }
}
