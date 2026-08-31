import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/main/core/native/index.js', () => ({
  WindowManager: {}
}))
vi.mock('electron', () => ({
  app: { getPath: vi.fn() }
}))

import {
  parseDesktopFile,
  parseMoBuffer,
  getLocaleCandidates,
  resolveLocalizedField,
  parseDesktopFileToCommand
} from '../../src/main/core/commandScanner/linuxScanner'

describe('linuxScanner', () => {
  describe('parseDesktopFile', () => {
    it('应正确解析 [Desktop Entry] 下的键值对', () => {
      const content = `
[Desktop Entry]
Name=AisleRiot Solitaire
Comment=Play many different solitaire games
Exec=sol %u
Icon=gnome-aisleriot
Terminal=false
Type=Application
Categories=GNOME;GTK;Game;CardGame;
Keywords=solitaire;cards;klondike;spider;
X-Ubuntu-Gettext-Domain=aisleriot

[Desktop Action New]
Name=New Game
Exec=sol --new
`
      const entry = parseDesktopFile(content)
      expect(entry.Name).toBe('AisleRiot Solitaire')
      expect(entry.Comment).toBe('Play many different solitaire games')
      expect(entry.Exec).toBe('sol %u')
      expect(entry.Icon).toBe('gnome-aisleriot')
      expect(entry.Type).toBe('Application')
      expect(entry.Keywords).toBe('solitaire;cards;klondike;spider;')
      expect(entry['X-Ubuntu-Gettext-Domain']).toBe('aisleriot')
    })
  })

  describe('parseMoBuffer', () => {
    it('当 buffer 长度小于 20 字节时应返回空 Map', () => {
      const buf = Buffer.alloc(10)
      const res = parseMoBuffer(buf)
      expect(res.size).toBe(0)
    })

    it('当魔数不匹配时应返回空 Map', () => {
      const buf = Buffer.alloc(28)
      buf.writeUInt32LE(0x12345678, 0)
      const res = parseMoBuffer(buf)
      expect(res.size).toBe(0)
    })

    it('应正确解析小端序的 .mo 文件 buffer', () => {
      // 构造测试 .mo buffer
      // 原始字符串: "Hello", 译文: "你好"
      const origStr = 'Hello\0'
      const transStr = '你好\0'

      const headerSize = 28
      const origTableOffset = headerSize
      const transTableOffset = headerSize + 8 // 1 个条目 (8 字节)
      const stringDataOffset = headerSize + 16

      const origOffset = stringDataOffset
      const transOffset = stringDataOffset + Buffer.byteLength(origStr)

      const totalSize = transOffset + Buffer.byteLength(transStr)
      const buf = Buffer.alloc(totalSize)

      // Magic: 0x950412de
      buf.writeUInt32LE(0x950412de, 0)
      // Version: 0
      buf.writeUInt32LE(0, 4)
      // Number of strings: 1
      buf.writeUInt32LE(1, 8)
      // Offset of original string table: origTableOffset
      buf.writeUInt32LE(origTableOffset, 12)
      // Offset of translation string table: transTableOffset
      buf.writeUInt32LE(transTableOffset, 16)

      // Original table entry: len (5 without null), offset
      buf.writeUInt32LE(5, origTableOffset)
      buf.writeUInt32LE(origOffset, origTableOffset + 4)

      // Translation table entry: len (6 in utf8 for "你好"), offset
      buf.writeUInt32LE(Buffer.byteLength('你好'), transTableOffset)
      buf.writeUInt32LE(transOffset, transTableOffset + 4)

      // String data
      buf.write(origStr, origOffset, 'utf8')
      buf.write(transStr, transOffset, 'utf8')

      const result = parseMoBuffer(buf)
      expect(result.get('Hello')).toBe('你好')
    })

    it('应正确解析大端序的 .mo 文件 buffer', () => {
      const origStr = 'World\0'
      const transStr = '世界\0'

      const headerSize = 28
      const origTableOffset = headerSize
      const transTableOffset = headerSize + 8
      const stringDataOffset = headerSize + 16

      const origOffset = stringDataOffset
      const transOffset = stringDataOffset + Buffer.byteLength(origStr)

      const totalSize = transOffset + Buffer.byteLength(transStr)
      const buf = Buffer.alloc(totalSize)

      // Magic: 0x950412de 写入大端序（实际在磁盘首字节为 0x95，以小端读取时表现为 0xde120495）
      buf.writeUInt32BE(0x950412de, 0)
      buf.writeUInt32BE(0, 4)
      buf.writeUInt32BE(1, 8)
      buf.writeUInt32BE(origTableOffset, 12)
      buf.writeUInt32BE(transTableOffset, 16)

      buf.writeUInt32BE(5, origTableOffset)
      buf.writeUInt32BE(origOffset, origTableOffset + 4)

      buf.writeUInt32BE(Buffer.byteLength('世界'), transTableOffset)
      buf.writeUInt32BE(transOffset, transTableOffset + 4)

      buf.write(origStr, origOffset, 'utf8')
      buf.write(transStr, transOffset, 'utf8')

      const result = parseMoBuffer(buf)
      expect(result.get('World')).toBe('世界')
    })
  })

  describe('getLocaleCandidates', () => {
    it('应从 LANGUAGE / LANG 中提取候选语言', () => {
      const origLang = process.env.LANG
      const origLanguage = process.env.LANGUAGE
      try {
        process.env.LANG = 'zh_CN.UTF-8'
        process.env.LANGUAGE = 'zh_CN:zh:en_US'
        const candidates = getLocaleCandidates()
        expect(candidates).toContain('zh_CN')
        expect(candidates).toContain('zh')
        expect(candidates).toContain('en_US')
      } finally {
        process.env.LANG = origLang
        process.env.LANGUAGE = origLanguage
      }
    })
  })

  describe('resolveLocalizedField', () => {
    it('当 .desktop 包含 Name[zh_CN] 时优先使用', async () => {
      const entry = {
        Name: 'Calculator',
        'Name[zh_CN]': '计算器'
      }
      const res = await resolveLocalizedField(entry, 'Name')
      expect(res.primary).toBe('计算器')
      expect(res.allTranslations).toContain('计算器')
    })
  })

  describe('scanApplications', () => {
    it('扫描应用应返回非空应用列表，且正确包含关键系统应用', async () => {
      const { scanApplications } = await import('../../src/main/core/commandScanner/linuxScanner')
      const apps = await scanApplications()
      expect(Array.isArray(apps)).toBe(true)
      expect(apps.length).toBeGreaterThan(0)

      // 检查是否扫描到了纸牌或系统应用
      const solApp = apps.find((app) => app.path === 'sol' || app.name.includes('AisleRiot'))
      if (solApp) {
        expect(solApp.aliases).toBeDefined()
        const allText = [solApp.name, ...(solApp.aliases || [])].join(' ')
        expect(allText).toMatch(/(单人纸牌|接龙|纸牌|AisleRiot)/i)
      }
    })
  })
})
