# 可配置终端选择功能 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「在终端打开」支持用户在三平台选择终端应用（预设 + 自定义命令），并消除两处重复的终端启动逻辑。

**Architecture:** 新建 `src/main/utils/terminalLauncher.ts` 统一终端启动：预设注册表（声明式 cli/applescript + handler）+ 纯函数（选项/解析/路径替换，可单测）+ 编排函数 `openInTerminal`（读 settings-general 配置分发）。两个调用点（`systemCommands.handleOpenTerminal` 与 `appleScriptHelper.openInTerminal`）改为委托它。

**Tech Stack:** Electron 41 + Vue 3 + TypeScript；vitest 单测；child_process 的 spawn/exec；LMDB（databaseAPI，主进程同步读写）。

**关键已核实事实：**
- `databaseAPI.dbGet(key): any` 是**同步**（`src/main/api/shared/database.ts:416`），主进程直接 `databaseAPI.dbGet('settings-general')` 无需 await。
- 待移动的 `openTerminalOnMac` / `openTerminalOnLinux` / `tryLaunchWindowsTerminal` / `escapePowerShellPath` / `escapeCmdPath` **无任何外部引用**（仅在 `systemCommands.ts` 内部），删除安全。
- 设置插件（`internal-plugins/setting`）是独立 Vite 应用，**不能 import 主进程代码**。因此预设下拉选项的 label/value 列表在 `GeneralSetting.vue` 内按平台重复一份（仅 UI 标签，启动逻辑仍以 terminalLauncher 为唯一源）。
- `GeneralSetting.vue` 已有 `platform` ref（102 行）由 `getPlatformInfo()`（1148 行）填充；已有 `saveSettings` 合并写（1258）、`loadSettings`（1162）模式可复用。

**与 spec 的两处偏离（及理由）：**
1. **内联命令解析器**，不导出复用 `linuxLauncher.ts` 的 `parseCommandString`。理由：`linuxLauncher.ts` 顶部 import 了 `dialog`/`WindowManager`/`fs`，从它导入会把这些重依赖传染进 terminalLauncher；内联 15 行解析器可保持 terminalLauncher 为干净叶子模块。
2. **暂不含 Warp 预设**。理由：Warp 在 macOS 的「打开并 cd 到目录」启动方式未经验证（`open -na Warp.app` 无法保证 cd），先不发布一个可能无效的预设；待确认后再补。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/main/utils/terminalLauncher.ts` | 统一终端启动：类型/转义/解析原语/默认处理器/预设注册表/纯函数/编排 `openInTerminal` | 新建 |
| `tests/main/terminalLauncher.test.ts` | 纯函数 + 编排分发单测 | 新建 |
| `src/main/api/renderer/systemCommands.ts` | 删除迁出的 3 函数 + 2 转义辅助；`handleOpenTerminal` 改为调 terminalLauncher | 修改 |
| `src/main/utils/appleScriptHelper.ts` | `openInTerminal` 改为委托 terminalLauncher | 修改 |
| `internal-plugins/setting/src/constants.ts` | 加 `TerminalType` 类型 | 修改 |
| `internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue` | 加终端设置 ref/选项/load/save/UI | 修改 |

---

### Task 1: 创建 terminalLauncher.ts（纯逻辑 + 预设 + 执行原语，TDD）

**Files:**
- Create: `src/main/utils/terminalLauncher.ts`
- Test: `tests/main/terminalLauncher.test.ts`

- [ ] **Step 1: 写纯函数的失败测试**

创建 `tests/main/terminalLauncher.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import {
  getPresetOptions,
  resolvePreset,
  applyPathToArgs,
  parseCustomCommand
} from '../../src/main/utils/terminalLauncher'

// ========== getPresetOptions ==========

describe('getPresetOptions', () => {
  it('macOS 含 系统默认/Ghostty/iTerm2/自定义', () => {
    const opts = getPresetOptions('darwin')
    expect(opts.map((o) => o.value)).toEqual(['default', 'ghostty', 'iterm2', 'custom'])
  })

  it('Linux 含 系统默认/gnome-terminal/konsole/xterm/自定义', () => {
    const opts = getPresetOptions('linux')
    expect(opts.map((o) => o.value)).toEqual([
      'default',
      'gnome-terminal',
      'konsole',
      'xterm',
      'custom'
    ])
  })

  it('Windows 含 系统默认/wt/powershell/cmd/自定义', () => {
    const opts = getPresetOptions('win32')
    expect(opts.map((o) => o.value)).toEqual([
      'default',
      'wt',
      'powershell',
      'cmd',
      'custom'
    ])
  })

  it('未知平台返回空数组', () => {
    expect(getPresetOptions('freebsd')).toEqual([])
  })
})

// ========== resolvePreset ==========

describe('resolvePreset', () => {
  it('空值返回默认预设', () => {
    expect(resolvePreset(undefined, 'darwin')?.id).toBe('default')
  })

  it('custom 返回 null', () => {
    expect(resolvePreset('custom', 'darwin')).toBeNull()
  })

  it('有效 id 返回对应预设', () => {
    expect(resolvePreset('ghostty', 'darwin')?.id).toBe('ghostty')
  })

  it('无效 id 回退默认', () => {
    expect(resolvePreset('nonexistent', 'darwin')?.id).toBe('default')
  })

  it('id 在当前平台不存在时回退默认', () => {
    expect(resolvePreset('ghostty', 'win32')?.id).toBe('default')
  })
})

// ========== applyPathToArgs ==========

describe('applyPathToArgs', () => {
  it('替换 {path} 占位符', () => {
    expect(applyPathToArgs(['--working-directory={path}'], '/Users/x')).toEqual([
      '--working-directory=/Users/x'
    ])
  })

  it('多个占位符都替换', () => {
    expect(applyPathToArgs(['{path}', 'cd {path}'], '/p')).toEqual(['/p', 'cd /p'])
  })

  it('无占位符保持不变', () => {
    expect(applyPathToArgs(['-la'], '/p')).toEqual(['-la'])
  })
})

// ========== parseCustomCommand ==========

describe('parseCustomCommand', () => {
  it('解析命令与参数', () => {
    expect(parseCustomCommand('alacritty --working-directory={path}')).toEqual({
      command: 'alacritty',
      args: ['--working-directory={path}']
    })
  })

  it('处理引号包裹的参数（去除引号）', () => {
    expect(parseCustomCommand('open -na "Ghostty.app"')).toEqual({
      command: 'open',
      args: ['-na', 'Ghostty.app']
    })
  })

  it('空字符串/纯空白返回 null', () => {
    expect(parseCustomCommand('')).toBeNull()
    expect(parseCustomCommand('   ')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/main/terminalLauncher.test.ts`
Expected: FAIL — 模块 `../../src/main/utils/terminalLauncher` 不存在，导入报错。

- [ ] **Step 3: 创建 terminalLauncher.ts（本步不含编排函数与 database 导入）**

创建 `src/main/utils/terminalLauncher.ts`：

```ts
import { exec, spawn } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// ==================== 类型 ====================

/** 预设选项（供 UI 下拉使用） */
export interface PresetOption {
  label: string
  value: string
}

/** 预设的启动方式 */
type Preset =
  | { type: 'cli'; command: string; args: string[] } // args 中可含 '{path}' 占位符
  | { type: 'applescript'; build: (path: string) => string } // 返回完整 AppleScript
  | { type: 'handler'; run: (path: string) => Promise<boolean> } // 自定义启动（回退链等）

interface PresetEntry {
  id: string
  label: string
  preset: Preset
}

// ==================== 路径转义（从 systemCommands 迁入，行为不变）====================

function escapePowerShellPath(folderPath: string): string {
  const escaped = folderPath.replace(/'/g, "''")
  return `'${escaped}'`
}

function escapeCmdPath(folderPath: string): string {
  const escaped = folderPath.replace(/"/g, '^"')
  return `"${escaped}"`
}

// ==================== 命令字符串解析（内联，避免耦合 commandLauncher）====================

/** 将命令字符串拆分为 [可执行文件, 参数列表]，处理引号 */
function parseCommandString(cmd: string): [string, string[]] {
  const parts: string[] = []
  let current = ''
  let inQuote: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (/\s/.test(ch)) {
      if (current) {
        parts.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  return [parts[0], parts.slice(1)]
}

// ==================== 执行原语 ====================

/** 执行 AppleScript（转义单引号，防止 shell 注入） */
async function runAppleScript(script: string): Promise<void> {
  const escaped = script.replace(/'/g, "'\\''")
  await execAsync(`osascript -e '${escaped}'`)
}

/** detached 启动 CLI 命令，返回是否成功拿到 pid */
function runCli(command: string, args: string[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => resolve(false))
    if (child.pid) {
      child.unref()
      resolve(true)
    }
  })
}

// ==================== 默认处理器（从 systemCommands 迁入，行为不变）====================

async function launchDefaultMac(path: string): Promise<boolean> {
  const script = `
    tell application "Terminal"
      activate
      do script "cd " & quoted form of "${path}"
    end tell
  `
  await runAppleScript(script)
  return true
}

async function launchDefaultLinux(path: string): Promise<boolean> {
  return (
    (await runCli('exo-open', ['--launch', 'TerminalEmulator', '--working-directory', path])) ||
    (await runCli('gnome-terminal', [`--working-directory=${path}`])) ||
    (await runCli('xterm', ['-cd', path]))
  )
}

async function launchDefaultWindows(path: string): Promise<boolean> {
  return (
    (await runCli('wt.exe', ['-d', path])) ||
    (await runCli('powershell.exe', [
      '-NoExit',
      '-Command',
      `Set-Location -Path ${escapePowerShellPath(path)}`
    ])) ||
    (await runCli('cmd.exe', ['/K', `cd /d ${escapeCmdPath(path)}`]))
  )
}

// ==================== 预设注册表 ====================

const MAC_PRESETS: PresetEntry[] = [
  {
    id: 'default',
    label: '系统默认 (Terminal)',
    preset: {
      type: 'applescript',
      build: (p) => `
    tell application "Terminal"
      activate
      do script "cd " & quoted form of "${p}"
    end tell
  `
    }
  },
  {
    id: 'ghostty',
    label: 'Ghostty',
    preset: {
      type: 'cli',
      command: 'open',
      args: ['-na', 'Ghostty.app', '--args', '--working-directory={path}']
    }
  },
  {
    id: 'iterm2',
    label: 'iTerm2',
    preset: {
      type: 'applescript',
      build: (p) => `
    tell application "iTerm"
      activate
      tell (create window with default profile)
        write session "cd " & quoted form of "${p}"
      end tell
    end tell
  `
    }
  }
]

const LINUX_PRESETS: PresetEntry[] = [
  { id: 'default', label: '系统默认', preset: { type: 'handler', run: launchDefaultLinux } },
  {
    id: 'gnome-terminal',
    label: 'GNOME Terminal',
    preset: { type: 'cli', command: 'gnome-terminal', args: ['--working-directory={path}'] }
  },
  {
    id: 'konsole',
    label: 'Konsole',
    preset: { type: 'cli', command: 'konsole', args: ['--workdir', '{path}'] }
  },
  {
    id: 'xterm',
    label: 'XTerm',
    preset: { type: 'cli', command: 'xterm', args: ['-cd', '{path}'] }
  }
]

const WINDOWS_PRESETS: PresetEntry[] = [
  { id: 'default', label: '系统默认', preset: { type: 'handler', run: launchDefaultWindows } },
  {
    id: 'wt',
    label: 'Windows Terminal',
    preset: { type: 'cli', command: 'wt.exe', args: ['-d', '{path}'] }
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    preset: {
      type: 'handler',
      run: (p) =>
        runCli('powershell.exe', [
          '-NoExit',
          '-Command',
          `Set-Location -Path ${escapePowerShellPath(p)}`
        ])
    }
  },
  {
    id: 'cmd',
    label: 'CMD',
    preset: {
      type: 'handler',
      run: (p) => runCli('cmd.exe', ['/K', `cd /d ${escapeCmdPath(p)}`])
    }
  }
]

// ==================== 纯函数（可单测）====================

function getPlatformPresets(platform: string): PresetEntry[] {
  if (platform === 'darwin') return MAC_PRESETS
  if (platform === 'linux') return LINUX_PRESETS
  if (platform === 'win32') return WINDOWS_PRESETS
  return []
}

/** 返回当前平台的下拉选项（含「自定义」） */
export function getPresetOptions(platform: string): PresetOption[] {
  const options = getPlatformPresets(platform).map((p) => ({ label: p.label, value: p.id }))
  options.push({ label: '自定义', value: 'custom' })
  return options
}

/** 按 terminal 值解析预设；空值/无效值回退默认，'custom' 返回 null（由编排函数处理） */
export function resolvePreset(
  terminal: string | undefined,
  platform: string
): PresetEntry | null {
  const presets = getPlatformPresets(platform)
  if (!terminal) {
    return presets.find((p) => p.id === 'default') ?? null
  }
  if (terminal === 'custom') return null
  return presets.find((p) => p.id === terminal) ?? presets.find((p) => p.id === 'default') ?? null
}

/** 将 args 中的 {path} 占位符替换为实际路径 */
export function applyPathToArgs(args: string[], folderPath: string): string[] {
  return args.map((a) => a.replaceAll('{path}', folderPath))
}

/** 解析自定义命令模板；空字符串返回 null */
export function parseCustomCommand(template: string): { command: string; args: string[] } | null {
  const trimmed = template.trim()
  if (!trimmed) return null
  const [command, ...args] = parseCommandString(trimmed)
  if (!command) return null
  return { command, args }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/main/terminalLauncher.test.ts`
Expected: PASS — 4 个 describe 共 16 个用例全部通过。

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck:node`
Expected: 无错误（terminalLauncher 在 `tsconfig.node.json` 的 `src/main/**` include 内）。

- [ ] **Step 6: 提交**

```bash
git add src/main/utils/terminalLauncher.ts tests/main/terminalLauncher.test.ts
git commit -m "feat(terminal): 新建 terminalLauncher 统一终端启动纯逻辑与预设"
```

---

### Task 2: 添加编排函数 openInTerminal（TDD with mocks）

**Files:**
- Modify: `src/main/utils/terminalLauncher.ts`（追加 database 导入 + executePreset + openInTerminal）
- Test: `tests/main/terminalLauncher.test.ts`（追加编排分发用例）

- [ ] **Step 1: 追加编排分发的失败测试**

在 `tests/main/terminalLauncher.test.ts` **顶部**添加 mock 与新的 import（原文件顶部的 `import { ... } from '../../src/main/utils/terminalLauncher'` 保留，但需在 mock 声明之后）。将文件顶部改为：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDbGet = vi.fn()
const mockSpawn = vi.fn()
const mockExec = vi.fn((...args: unknown[]) => {
  const cb = args[args.length - 1]
  if (typeof cb === 'function') cb(null, { stdout: '', stderr: '' })
})

vi.mock('child_process', () => ({ spawn: mockSpawn, exec: mockExec }))
vi.mock('../../src/main/api/shared/database', () => ({
  default: { dbGet: mockDbGet, dbPut: vi.fn() }
}))

import {
  getPresetOptions,
  resolvePreset,
  applyPathToArgs,
  parseCustomCommand,
  openInTerminal
} from '../../src/main/utils/terminalLauncher'
```

在文件末尾追加：

```ts
// ========== openInTerminal 编排分发 ==========

describe('openInTerminal 编排分发', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSpawn.mockImplementation(() => ({ pid: 12345, unref: vi.fn(), on: vi.fn() }))
  })

  it('预设 ghostty → spawn open 并替换 {path}', async () => {
    mockDbGet.mockReturnValue({ terminal: 'ghostty' })
    const ok = await openInTerminal('/Users/test/proj')
    expect(ok).toBe(true)
    expect(mockSpawn).toHaveBeenCalledWith(
      'open',
      ['-na', 'Ghostty.app', '--args', '--working-directory=/Users/test/proj'],
      expect.objectContaining({ detached: true })
    )
  })

  it('自定义命令 → 解析并替换 {path}', async () => {
    mockDbGet.mockReturnValue({
      terminal: 'custom',
      terminalCustomCommand: 'alacritty --working-directory={path}'
    })
    const ok = await openInTerminal('/my/dir')
    expect(ok).toBe(true)
    expect(mockSpawn).toHaveBeenCalledWith(
      'alacritty',
      ['--working-directory=/my/dir'],
      expect.objectContaining({ detached: true })
    )
  })

  it('自定义命令为空 → 回退默认（mac 走 applescript，不 spawn）', async () => {
    mockDbGet.mockReturnValue({ terminal: 'custom', terminalCustomCommand: '' })
    const ok = await openInTerminal('/x')
    expect(ok).toBe(true)
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockExec).toHaveBeenCalled()
  })
})
```

> 注：第 3 个用例依赖测试机为 macOS（`process.platform === 'darwin'`），本仓库开发机即 macOS，可接受。

- [ ] **Step 2: 运行测试确认新增用例失败**

Run: `pnpm test tests/main/terminalLauncher.test.ts`
Expected: FAIL — `openInTerminal` 未导出（`TypeError: openInTerminal is not a function`）。

- [ ] **Step 3: 在 terminalLauncher.ts 追加 database 导入与编排函数**

在文件**顶部 import 区**追加（在 `import { promisify } from 'util'` 之后）：

```ts
import databaseAPI from '../api/shared/database'
```

在文件**末尾**追加：

```ts

// ==================== 编排：读取配置 → 分发 ====================

async function executePreset(entry: PresetEntry | null, folderPath: string): Promise<boolean> {
  if (!entry) return false
  const preset = entry.preset
  if (preset.type === 'cli') {
    return runCli(preset.command, applyPathToArgs(preset.args, folderPath))
  }
  if (preset.type === 'applescript') {
    await runAppleScript(preset.build(folderPath))
    return true
  }
  return preset.run(folderPath)
}

export async function openInTerminal(folderPath: string): Promise<boolean> {
  try {
    const settings = (databaseAPI.dbGet('settings-general') as Record<string, any>) || {}
    const terminal: string | undefined = settings.terminal
    const customCommand: string | undefined = settings.terminalCustomCommand

    // 自定义命令优先
    if (terminal === 'custom') {
      const parsed = parseCustomCommand(customCommand ?? '')
      if (parsed) {
        return runCli(parsed.command, applyPathToArgs(parsed.args, folderPath))
      }
      // 自定义命令为空 → 回退默认
      return executePreset(resolvePreset('default', process.platform), folderPath)
    }

    return executePreset(resolvePreset(terminal, process.platform), folderPath)
  } catch (error) {
    console.error('[TerminalLauncher] 打开终端失败:', error)
    return false
  }
}
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `pnpm test tests/main/terminalLauncher.test.ts`
Expected: PASS — 全部用例（含 3 个编排分发用例）通过。

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck:node`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/main/utils/terminalLauncher.ts tests/main/terminalLauncher.test.ts
git commit -m "feat(terminal): 添加 openInTerminal 编排函数读取配置分发"
```

---

### Task 3: 接入 systemCommands.handleOpenTerminal，删除迁出代码

**Files:**
- Modify: `src/main/api/renderer/systemCommands.ts`

- [ ] **Step 1: 修改 handleOpenTerminal 的终端启动段**

在 `src/main/api/renderer/systemCommands.ts` 中，将 `handleOpenTerminal` 内 596-611 行的「根据平台打开终端」分支替换为调用 terminalLauncher。把这一段：

```ts
    // 根据平台打开终端
    if (process.platform === 'darwin') {
      await openTerminalOnMac(targetPath, execAsync)
    } else if (process.platform === 'linux') {
      const launched = await openTerminalOnLinux(targetPath)
      if (!launched) {
        throw new Error('Could not find a supported terminal emulator')
      }
    } else if (process.platform === 'win32') {
      const launched = await tryLaunchWindowsTerminal(targetPath)
      if (!launched) {
        return { success: false, error: '无法启动终端' }
      }
    } else {
      return { success: false, error: `不支持的平台: ${process.platform}` }
    }
```

替换为：

```ts
    // 打开终端（统一走 terminalLauncher，按用户配置分发）
    const launched = await terminalLauncher.openInTerminal(targetPath)
    if (!launched) {
      return { success: false, error: '无法启动终端' }
    }
```

- [ ] **Step 2: 添加 terminalLauncher 导入**

在 `systemCommands.ts` 顶部 import 区（`import databaseAPI from '../shared/database'` 附近）追加：

```ts
import * as terminalLauncher from '../../utils/terminalLauncher'
```

- [ ] **Step 3: 删除迁出的函数与转义辅助**

从 `systemCommands.ts` 中**整段删除**以下五处（它们已被 terminalLauncher 取代，且无外部引用）：
- `escapePowerShellPath`（原 50-53）
- `escapeCmdPath`（原 59-63）
- `tryLaunchWindowsTerminal`（原 65-88，含其内部 `tryLaunch`）
- `openTerminalOnMac`（原 497-508）
- `openTerminalOnLinux`（原 514-536，含其内部 `tryLaunch`）

> 注意：`getMacFinderPath`（541-555）**保留不动**，它属于路径获取。

- [ ] **Step 4: 类型检查**

Run: `pnpm typecheck:node`
Expected: 无错误。若报 `spawn`/`exec` 未使用，确认 `systemCommands.ts` 顶部 `import { exec, spawn } from 'child_process'` 是否还被其他函数使用（如 executeSystemCommand 内的其他命令）；若仍被使用则保留，若不再被使用则一并删除该 import 的未用符号。

- [ ] **Step 5: 运行全量测试确认无回归**

Run: `pnpm test`
Expected: 全部通过（terminalLauncher 用例通过，其他用例不受影响）。

- [ ] **Step 6: 提交**

```bash
git add src/main/api/renderer/systemCommands.ts
git commit -m "refactor(terminal): handleOpenTerminal 改用 terminalLauncher 并删除迁出代码"
```

---

### Task 4: appleScriptHelper.openInTerminal 改为委托 terminalLauncher

**Files:**
- Modify: `src/main/utils/appleScriptHelper.ts:184-200`

- [ ] **Step 1: 改写 openInTerminal 方法**

将 `src/main/utils/appleScriptHelper.ts` 中 `openInTerminal` 方法（184-200）：

```ts
  async openInTerminal(path: string): Promise<boolean> {
    try {
      // 转义路径中的单引号
      const escapedPath = path.replace(/'/g, "'\\''")
      const script = `
        tell application "Terminal"
          activate
          do script "cd '${escapedPath}'"
        end tell
      `
      await this.execute(script)
      return true
    } catch (error) {
      console.error('[AppleScript] 在终端打开路径失败:', error)
      return false
    }
  }
```

替换为：

```ts
  async openInTerminal(path: string): Promise<boolean> {
    try {
      return await terminalLauncher.openInTerminal(path)
    } catch (error) {
      console.error('[AppleScript] 在终端打开路径失败:', error)
      return false
    }
  }
```

- [ ] **Step 2: 添加 terminalLauncher 导入**

在 `appleScriptHelper.ts` 顶部 import 区追加：

```ts
import * as terminalLauncher from './terminalLauncher'
```

> 注意：`appleScriptHelper.ts` 的 `execute` 私有方法仍被其他方法（getFinderPath 等）使用，保留不动。

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck:node`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add src/main/utils/appleScriptHelper.ts
git commit -m "refactor(terminal): appleScriptHelper.openInTerminal 委托 terminalLauncher"
```

---

### Task 5: constants.ts 添加 TerminalType 类型

**Files:**
- Modify: `internal-plugins/setting/src/constants.ts`

- [ ] **Step 1: 添加类型**

在 `internal-plugins/setting/src/constants.ts` 末尾追加：

```ts
/** 「在终端打开」使用的终端选择：'default' 系统默认 ｜ 'custom' 自定义命令 ｜ 其他预设 id */
export type TerminalType = 'default' | 'custom' | string
```

> 说明：预设 id（ghostty/iterm2/wt 等）是平台相关的字符串，不做成联合字面量；TerminalType 仅约束「至少是字符串」，运行时由 terminalLauncher 校验 id 有效性并回退默认。

- [ ] **Step 2: 提交**

```bash
git add internal-plugins/setting/src/constants.ts
git commit -m "feat(terminal): 添加 TerminalType 类型"
```

---

### Task 6: GeneralSetting.vue 添加终端设置 UI

**Files:**
- Modify: `internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue`

- [ ] **Step 1: 添加 ref 与选项 computed**

在 `GeneralSetting.vue` 的 `<script setup>` 中，`platform` ref（102 行）之后添加：

```ts
// 终端打开设置
const terminal = ref<TerminalType>('default')
const terminalCustomCommand = ref('')

// 终端预设选项（按平台；仅 UI 标签，启动逻辑在主进程 terminalLauncher）
const terminalOptions = computed(() => {
  if (platform.value === 'win32') {
    return [
      { label: '系统默认', value: 'default' },
      { label: 'Windows Terminal', value: 'wt' },
      { label: 'PowerShell', value: 'powershell' },
      { label: 'CMD', value: 'cmd' },
      { label: '自定义', value: 'custom' }
    ]
  }
  if (platform.value === 'linux') {
    return [
      { label: '系统默认', value: 'default' },
      { label: 'GNOME Terminal', value: 'gnome-terminal' },
      { label: 'Konsole', value: 'konsole' },
      { label: 'XTerm', value: 'xterm' },
      { label: '自定义', value: 'custom' }
    ]
  }
  return [
    { label: '系统默认 (Terminal)', value: 'default' },
    { label: 'Ghostty', value: 'ghostty' },
    { label: 'iTerm2', value: 'iterm2' },
    { label: '自定义', value: 'custom' }
  ]
})
```

并在 import 区引入类型（若 `TerminalType` 尚未导入）：

```ts
import type { TerminalType } from '@/constants'
```

> 确认 `@/constants` 别名可用：`internal-plugins/setting/src/views/PluginsSetting/PluginsSetting.vue` 等已用 `@/` 别名引用 constants。若 `computed` 未导入，从 `vue` 补充导入。

- [ ] **Step 2: loadSettings 读取两字段**

在 `loadSettings()`（1162 起）的 `if (data) { ... }` 块内追加（与其他字段同处）：

```ts
      terminal.value = data.terminal ?? 'default'
      terminalCustomCommand.value = data.terminalCustomCommand ?? ''
```

- [ ] **Step 3: saveSettings 合并写两字段**

在 `saveSettings()`（1258）的 `dbPut('settings-general', { ...existing, ... })` 对象内追加（建议放在 `clipboardRetentionDays` 之后）：

```ts
      terminal: terminal.value,
      terminalCustomCommand: terminalCustomCommand.value
```

- [ ] **Step 4: 添加 UI 模板**

在模板中找一个合适位置（建议放在「外观」`setting-group` 之后，或「通用」组末尾），新增一个 `setting-group`：

```html
    <!-- ==================== 终端打开 ==================== -->
    <div class="setting-group">
      <h3 class="setting-group-title">终端打开</h3>

      <div class="setting-item">
        <div class="setting-label">
          <span>打开终端应用</span>
          <span class="setting-desc">从 Finder 唤出「在终端打开」时使用的终端</span>
        </div>
        <div class="setting-control">
          <Dropdown v-model="terminal" :options="terminalOptions" @change="saveSettings" />
        </div>
      </div>

      <div v-if="terminal === 'custom'" class="setting-item">
        <div class="setting-label">
          <span>自定义命令</span>
          <span class="setting-desc">用 {path} 代表目标目录，如 ghostty --working-directory={path}</span>
        </div>
        <div class="setting-control">
          <input
            v-model="terminalCustomCommand"
            type="text"
            class="input"
            placeholder="alacritty --working-directory={path}"
            @blur="saveSettings"
            @keyup.enter="saveSettings"
          />
        </div>
      </div>
    </div>
```

- [ ] **Step 5: 类型检查**

Run: `cd internal-plugins/setting && pnpm vue-tsc --noEmit -p tsconfig.json` （或仓库根的 `pnpm typecheck:web`）
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue
git commit -m "feat(terminal): 通用设置页新增终端选择与自定义命令 UI"
```

---

### Task 7: 全量验证

**Files:** 无（验证 only）

- [ ] **Step 1: 全量类型检查 + 测试**

Run: `pnpm typecheck && pnpm test`
Expected: 全部通过。

- [ ] **Step 2: 构建**

Run: `pnpm build`
Expected: 构建成功（含 `build:setting`）。

- [ ] **Step 3: 手动验证 — macOS Ghostty（核心用例）**

Run: `pnpm dev`
1. 打开设置 → 通用设置 → 终端打开 → 选「Ghostty」。
2. 在 Finder 选中一个文件夹 → 用 ZTools 唤出 →「在终端打开」。
3. Expected: Ghostty 打开并 cd 到该目录。

- [ ] **Step 4: 手动验证 — 系统默认无回归**

1. 设置 → 终端打开 → 选「系统默认 (Terminal)」。
2. Finder 唤出「在终端打开」。
3. Expected: Terminal.app 打开并 cd（与改动前行为一致）。

- [ ] **Step 5: 手动验证 — 自定义命令**

1. 设置 → 终端打开 → 选「自定义」→ 填 `open -na Ghostty.app --args --working-directory={path}`。
2. Finder 唤出「在终端打开」。
3. Expected: Ghostty 打开并 cd 到该目录。

- [ ] **Step 6: 手动验证 — 合并写安全**

1. 修改终端设置后，重新打开设置页，确认 theme / 唤醒黑名单等其他字段未被覆盖。
2. Expected: 其他设置值保持不变。

- [ ] **Step 7: 收尾提交（如有验证中发现的修复）**

```bash
git add -A
git commit -m "test(terminal): 验证通过"
```

---

## Self-Review（计划自检）

**1. Spec 覆盖：**
- ✅ 新建 terminalLauncher 统一两处 → Task 1+2+3+4
- ✅ settings-general 加 terminal / terminalCustomCommand → Task 6（save/load）
- ✅ 三平台预设 → Task 1 注册表
- ✅ macOS Ghostty `open -na Ghostty.app --args --working-directory={path}` → Task 1 MAC_PRESETS
- ✅ UI 塞进通用设置页、Dropdown + 条件输入框 → Task 6
- ✅ 无新增 IPC（主进程直接 dbGet）→ Task 2 openInTerminal
- ✅ 向后兼容（default 行为不变）→ Task 1 默认处理器迁入原逻辑
- ⚠️ Warp 预设：spec 列了但标注「待确认」，本计划暂不实现（计划头已说明理由）——如需补，加一个 MAC_PRESETS 条目即可。
- ⚠️ parseCommandString 复用 → 改为内联（计划头已说明理由）。

**2. 占位符扫描：** 无 TBD/TODO；每步含完整代码或确切命令。

**3. 类型一致性：** `openInTerminal(folderPath: string): Promise<boolean>` 在 Task 2 定义，Task 3/4 调用签名一致；`PresetOption {label, value}` 在 Task 1 定义，Task 6 UI options 与之一致；`TerminalType` Task 5 定义，Task 6 使用。
