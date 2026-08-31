export type UpdateChannel = 'stable' | 'beta'

/**
 * 根据应用版本和用户偏好解析服务端更新通道。
 * @param version 当前应用版本。
 * @param receiveBetaUpdates 正式版是否主动接收 Beta 版本。
 * @returns 预发布版本或已开启 Beta 更新时使用 beta，否则使用 stable。
 */
export function resolveUpdateChannel(
  version: string,
  receiveBetaUpdates: boolean = false
): UpdateChannel {
  return version.includes('-') || receiveBetaUpdates ? 'beta' : 'stable'
}
