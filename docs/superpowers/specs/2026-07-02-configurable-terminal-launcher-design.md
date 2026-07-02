# 可配置终端选择功能

- 日期：2026-07-02
- 状态：已批准（待实现）
- 关联代码：`src/main/api/renderer/systemCommands.ts`、`src/main/utils/appleScriptHelper.ts`、`internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue`

## 背景与动机

ZTools 的「在终端打开」功能（从 Finder 唤出或插件 IPC 调用）在 macOS 上**硬编码**系统 `Terminal.app`，无法选择其他终端。用户安装了 Ghostty 后希望改用自定义终端，且项目是三平台（macOS/Linux/Windows）的，需要做成可配置功能。

当前终端启动逻辑**散落在两处且重复**：

1. `systemCommands.ts:497-508` `openTerminalOnMac` —— Finder 命令路径（`handleOpenTerminal` 557-621 调用），用 AppleScript `tell application "Terminal"`。
2. `appleScriptHelper.ts:184-200` `openInTerminal` —— 插件 IPC 路径（`system.ts:76-83` 的 `open-terminal` handler 调用），同样硬编码 `Terminal`，但路径转义方式不同（单引号替换 vs `quoted form of`）。

三平台均**无任何自定义终端配置项**。

## 目标

- 用户可在设置中选择「打开终端」时使用的终端应用，三平台均支持。
- 支持常见终端预设 + 用户自定义命令模板。
- 消除两处重复的终端启动逻辑，统一为一个模块。
- 向后兼容：未配置时行为与现状完全一致。

## 非目标（YAGNI）

- 不做终端自动检测（扫描已安装的终端）。
- 不为自定义命令做弹窗错误提示（仅记日志 + 回退默认）。
- 不支持 AppleScript 类型的自定义命令（自定义仅限 CLI 命令模板）。
- 不新增设置页路由（塞进现有通用设置页）。

## 架构

### 新模块：`src/main/utils/terminalLauncher.ts`

导出单一函数：

```ts
export async function openInTerminal(folderPath: string): Promise<boolean>
```

返回 `true` 表示成功启动，`false` 表示失败（调用方据此返回错误信息）。内部自建 `execAsync = promisify(exec)` 与 `spawn`，不依赖调用方传入。

#### 内部分发逻辑

```
openInTerminal(path)
  ├─ dbGet('settings-general') 读 terminal / terminalCustomCommand
  ├─ 据 process.platform 选当前平台预设表
  ├─ terminal 值无效（不在当前平台预设表且非 'custom'）→ 回退 'default'
  ├─ 'default' → 调用迁移过来的平台 default 函数
  ├─ 预设 id → 按预设描述启动
  └─ 'custom' → 解析 terminalCustomCommand，替换 {path}，spawn
```

#### 迁入的现有函数

以下三个函数从 `systemCommands.ts` **迁入** `terminalLauncher.ts`，作为 `'default'` 处理器（行为不变，去掉 `execAsync` 参数，改用模块内自建的 `execAsync`）：

- `openTerminalOnMac(folderPath)`（原 497-508）
- `openTerminalOnLinux(folderPath)`（原 514-536）
- `tryLaunchWindowsTerminal(folderPath)`（原 65-88，含 `escapePowerShellPath` / `escapeCmdPath` 两个转义辅助函数 50-63 一并迁入）

`getMacFinderPath`（541-555）属于**路径获取**，不属于终端启动，**保留在 `systemCommands.ts`** 不动。

### 调用点改造

| 调用点 | 现状 | 改造后 |
|---|---|---|
| `systemCommands.ts:handleOpenTerminal`（597-611） | 按平台调 `openTerminalOnMac` / `openTerminalOnLinux` / `tryLaunchWindowsTerminal` | 改为 `await terminalLauncher.openInTerminal(targetPath)`，据返回布尔值决定 `{success, error}`。路径获取段（572-590）保留不动。 |
| `appleScriptHelper.ts:openInTerminal`（184-200） | 自实现 AppleScript `tell application "Terminal"` | 改为委托 `return await terminalLauncher.openInTerminal(path)`，删除内部 AppleScript 脚本。保留 `Promise<boolean>` 签名，不动调用方 `system.ts:openTerminal`（76-83）。 |

## 数据模型

`settings-general` 文档（LMDB key `ZTOOLS/settings-general`）新增两字段，沿用项目「合并写」约定（`{...existing, terminal, terminalCustomCommand}`）：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `terminal` | `string` | `'default'` | `'default'` ｜预设 id（如 `'ghostty'`）｜`'custom'` |
| `terminalCustomCommand` | `string` | `''` | CLI 命令模板，含 `{path}` 占位符，仅 `terminal === 'custom'` 时使用 |

枚举类型定义于 `internal-plugins/setting/src/constants.ts`：

```ts
export type TerminalType = 'default' | 'custom'  // 预设 id 为字符串字面量，运行时校验
```

> 预设 id 不做成联合字面量类型，因为各平台预设不同且可能扩展；运行时用「当前平台预设表」校验 id 有效性，无效则回退 `'default'`。

## 预设注册表（按平台）

预设用**声明式数据**描述，尽量不做 per-preset 函数。两种预设类型：

- **CLI 型**：`{ type: 'cli', command: string, args: string[] }`，`args` 中可含 `{path}` 占位符，启动前替换。用 `spawn` detached。
- **AppleScript 型**：`{ type: 'applescript', script: string }`，`script` 中可含 `{path}`，用 `osascript -e` 执行。用 `execAsync`。

### macOS

| id | 类型 | 启动方式 |
|---|---|---|
| `default` | applescript | 现有 `tell application "Terminal" / activate / do script "cd " & quoted form of "{path}"` |
| `ghostty` | cli | `open -na Ghostty.app --args --working-directory={path}` |
| `iterm2` | applescript | `tell application "iTerm" / create window with default profile / write session "cd {path}"` |
| `warp` | cli | `open -na Warp.app`（Warp 自行处理目录；实现时确认是否需 `--args`） |

> macOS 上 `ghostty` CLI 不能直接启动终端（已验证 `ghostty --help`），必须用 `open -na Ghostty.app --args ...`。`--working-directory` 是 Ghostty 有效配置项（已验证 `ghostty +show-config`）。

### Linux

| id | 类型 | 启动方式 |
|---|---|---|
| `default` | 函数 | 现有回退链 `exo-open → gnome-terminal → xterm` |
| `gnome-terminal` | cli | `gnome-terminal --working-directory={path}` |
| `konsole` | cli | `konsole --workdir {path}` |
| `xterm` | cli | `xterm -cd {path}` |

### Windows

| id | 类型 | 启动方式 |
|---|---|---|
| `default` | 函数 | 现有回退链 `wt → powershell → cmd`（含路径转义） |
| `wt` | cli | `wt.exe -d {path}` |
| `powershell` | cli | `powershell.exe -NoExit -Command "Set-Location -Path '{path}'"`（用 `escapePowerShellPath`） |
| `cmd` | cli | `cmd.exe /K cd /d "{path}"`（用 `escapeCmdPath`） |

三平台均有 `custom`（走自定义命令模板）。

> Linux/Windows 的 `default` 是回退链函数，不适用声明式数据描述，保留为函数形态。

## 数据流

```
[设置页] 用户选终端 + 填自定义命令
    → GeneralSetting.saveSettings()
    → dbPut('settings-general', {...existing, terminal, terminalCustomCommand})  // 合并写

[打开终端时] handleOpenTerminal / appleScriptHelper.openInTerminal
    → terminalLauncher.openInTerminal(path)
        → dbGet('settings-general') 读 terminal / terminalCustomCommand
        → 按 process.platform 选预设表，校验 id
        → 分发：default | 预设(cli/applescript) | custom(解析命令模板，替换 {path}，spawn)
```

**无新增 IPC、无内存缓存、无启动回放**：配置仅在打开终端时由主进程直接 `dbGet` 读取一次。

## 自定义命令处理

- 用户在 `terminalCustomCommand` 填写完整命令，如 `alacritty --working-directory={path}`。
- 处理步骤：
  1. 用项目现有的 `parseCommandString`（`src/main/core/commandLauncher/linuxLauncher.ts:11`，签名 `(cmd: string) => [string, string[]]`，处理引号）拆分命令为 `command + args`。该函数当前**未导出**，实现时需将其改为 `export function`（一词改动）并在 terminalLauncher 中导入复用，避免重复造轮子。
  2. 将每个 arg 中的 `{path}` 替换为目标路径。
  3. `spawn(command, args, { detached: true, stdio: 'ignore' })` + `child.unref()`。
- macOS 提示：若终端不支持 CLI 直接启动（如 Ghostty），需写 `open -na AppName.app --args --working-directory={path}`。

## 设置 UI

塞进 `internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue`，新增一个 `.setting-group`「终端打开」：

- **Dropdown**：选项 = 当前平台预设列表 + `系统默认`（`default`）+ `自定义`（`custom`）。
  - 平台判断：复用 `GeneralSetting.vue` 已有的 `platform` ref（102 行，由 `getPlatformInfo()` 1148-1157 通过 `window.ztools.internal.getPlatform()` 填充），据 `platform.value` 返回对应预设数组。
- **条件文本输入框**：仅当 Dropdown 选中 `custom` 时显示，绑定 `terminalCustomCommand`，占位符示例 `alacritty --working-directory={path}`。macOS 下附一句小字提示「若终端不支持 CLI 直接启动，可用 `open -na AppName.app --args ...`」。
- 控件 `@change` 调 `saveSettings()`（与同页其他设置一致）。

### GeneralSetting.vue 具体改动点

| 位置 | 改动 |
|---|---|
| `<script>` ref 声明区（~165 行附近） | 加 `const terminal = ref<TerminalType>('default')`、`const terminalCustomCommand = ref('')` |
| 选项数据区（20-99 行附近） | 加当前平台预设选项数组（动态，按平台返回） |
| `loadSettings()`（1162-1247） | 加 `terminal.value = data.terminal ?? 'default'`、`terminalCustomCommand.value = data.terminalCustomCommand ?? ''` |
| `saveSettings()`（1250-1306） | dbPut 对象加 `terminal: terminal.value`、`terminalCustomCommand: terminalCustomCommand.value` |
| 模板 | 新增 `.setting-group` 含 Dropdown + 条件输入框 |

## 错误处理

- 自定义命令解析失败 / 终端二进制不存在（spawn `error` 事件）→ catch，`console.error` 记日志，返回 `false`（`handleOpenTerminal` 据此返回 `{success: false, error}`）。
- 存的 `terminal` id 在当前平台无效 → 回退 `'default'`，记一条 warn 日志。
- 不做弹窗提示（YAGNI）。

## 验证标准

因启动终端难以单元测试，采用手动验证：

1. **macOS Ghostty**：Finder 唤出 → 设置选 Ghostty → 在目标目录打开 Ghostty 窗口。
2. **默认无回归**：设置选「系统默认」→ macOS 行为与改动前一致（Terminal.app 打开并 cd）。
3. **自定义命令**：选「自定义」填 `open -na Ghostty.app --args --working-directory={path}` → 同样打开 Ghostty。
4. **插件 IPC 路径**：通过 `open-terminal` IPC（appleScriptHelper 路径）打开 → 与 Finder 路径行为一致。
5. **Linux/Windows 无回归**：default 回退链行为不变。
6. **合并写安全**：修改终端设置后，通用设置页其他字段（如 theme、wakeupBlacklist）未被覆盖。

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/main/utils/terminalLauncher.ts` | **新建**。迁入三个 default 函数 + 预设表 + 配置读取 + custom 命令处理 + `openInTerminal` 导出。 |
| `src/main/api/renderer/systemCommands.ts` | 删除迁出的三个函数及两个转义辅助函数；`handleOpenTerminal` 的 597-611 段改为调 `terminalLauncher.openInTerminal`。 |
| `src/main/utils/appleScriptHelper.ts` | `openInTerminal`（184-200）改为委托 `terminalLauncher.openInTerminal`，删除内部 AppleScript。 |
| `internal-plugins/setting/src/constants.ts` | 加 `TerminalType` 类型。 |
| `internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue` | 加终端设置 ref / 选项 / loadSettings / saveSettings / UI 模板。 |

## 待实现时确认的细节

- `parseCommandString` 位于 `src/main/core/commandLauncher/linuxLauncher.ts:11`，当前未导出，需改为 `export`（签名 `(cmd: string) => [string, string[]]`）。
- `databaseAPI` 在 `terminalLauncher.ts` 的相对导入路径（参考 `systemCommands.ts` 的导入）。
- Warp 在 macOS 的最佳启动方式（是否需 `--args` 传目录）。
