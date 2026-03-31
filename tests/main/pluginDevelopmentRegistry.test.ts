import { describe, expect, it } from 'vitest'
import {
  applyDevProjectsOrderUpdate,
  buildInstalledDevelopmentPlugin,
  canPackageDevProject,
  getDevPluginLocalBindingsKey,
  insertDevProjectAtTop,
  mergeLegacyDevelopmentProjects,
  migrateLegacyDevProjects,
  normalizeDevelopmentProject,
  readDevPluginLocalBindingsDoc,
  readDevPluginRegistryDoc,
  upsertDevProjectFromConfig,
  upsertDevProjectRecord,
  validateRepairConfigSelection
} from '../../src/main/api/renderer/pluginDevelopmentRegistry'

describe('pluginDevelopmentRegistry', () => {
  it('merges legacy development plugins into the registry without duplicates', () => {
    const merged = mergeLegacyDevelopmentProjects(
      [{ path: '/workspace/demo', addedAt: '2026-03-29T00:00:00.000Z' }],
      [
        { name: 'demo', path: '/workspace/demo', isDevelopment: true },
        { name: 'legacy-dev', path: '/workspace/legacy', isDevelopment: true }
      ]
    )

    expect(merged.map((item) => item.path)).toEqual(['/workspace/demo', '/workspace/legacy'])
  })

  it('preserves an existing record when the same project is added again', () => {
    const next = upsertDevProjectRecord(
      [{ path: '/workspace/demo', addedAt: '2026-03-29T00:00:00.000Z' }],
      '/workspace/demo',
      '2026-03-29T08:00:00.000Z'
    )

    expect(next).toEqual([{ path: '/workspace/demo', addedAt: '2026-03-29T00:00:00.000Z' }])
  })

  it('marks an uninstalled project as unavailable until development mode is explicitly installed', () => {
    const project = normalizeDevelopmentProject(
      '/workspace/demo',
      {
        name: 'demo',
        title: 'Demo',
        version: '1.0.0',
        description: 'local project',
        development: { main: 'http://localhost:8686/' }
      },
      [],
      []
    )

    expect(project.isDevModeInstalled).toBe(false)
    expect(project.isRunning).toBe(false)
  })

  it('derives installed and running status from host state', () => {
    const project = normalizeDevelopmentProject(
      '/workspace/demo',
      {
        name: 'demo',
        title: 'Demo',
        version: '1.0.0'
      },
      [{ path: '/workspace/demo', isDevelopment: true }],
      ['/workspace/demo']
    )

    expect(project.isDevModeInstalled).toBe(true)
    expect(project.isRunning).toBe(true)
  })

  it('builds the installed snapshot from development.main', () => {
    const installed = buildInstalledDevelopmentPlugin('/workspace/demo', {
      name: 'demo',
      title: 'Demo',
      version: '1.0.0',
      features: [{ code: 'ui.demo', cmds: ['Demo'] }],
      development: { main: 'http://localhost:8686/' }
    })

    expect(installed.isDevelopment).toBe(true)
    expect(installed.main).toBe('http://localhost:8686/')
    expect(installed.path).toBe('/workspace/demo')
  })

  it('generates device-local binding keys', () => {
    expect(getDevPluginLocalBindingsKey('alpha')).toBe('dev-plugin-local-bindings/alpha')
  })

  it('migrates legacy records into registry/local bindings while skipping built-ins and nameless configs', () => {
    const result = migrateLegacyDevProjects({
      legacyRecords: [
        { path: '/workspace/legacy', addedAt: '2026-03-29T00:00:00.000Z' },
        { path: '/workspace/extra', addedAt: '2026-03-29T01:00:00.000Z' }
      ],
      installedPlugins: [
        { name: 'demo', path: '/workspace/demo', isDevelopment: true },
        { name: 'setting', path: '/workspace/setting', isDevelopment: true }
      ],
      pluginConfigs: {
        '/workspace/demo/plugin.json': { name: 'demo', title: 'Demo', version: '1.0.0' },
        '/workspace/legacy': { name: 'legacy', title: 'Legacy', version: '0.1.0' },
        '/workspace/setting': { name: 'setting', title: 'Settings', version: '2.0.0' },
        '/workspace/extra': { title: 'Extra' }
      },
      deviceId: 'device-1'
    })

    expect(Object.keys(result.registry.projects).sort()).toEqual(['demo', 'legacy'])
    const demoEntry = result.registry.projects.demo
    expect(demoEntry).toHaveProperty('configSnapshot')
    expect(demoEntry.configSnapshot.name).toBe('demo')
    expect(demoEntry).not.toHaveProperty('path')
    expect(result.registry.projects.setting).toBeUndefined()
    expect(result.registry.projects.extra).toBeUndefined()
    const binding = result.localBindings.bindings.demo
    expect(binding.projectPath).toBe('/workspace/demo')
    expect(binding.configPath).toBe('/workspace/demo/plugin.json')
    expect(binding.status).toBe('ready')
    expect(binding.name).toBe('demo')
    expect(binding.lastValidatedAt).toBe(binding.updatedAt)
    expect(result.localBindings.deviceId).toBe('device-1')
  })

  it('rejects upsert when config name collides with different path', () => {
    const registry = {
      version: 2,
      projects: {
        demo: {
          name: 'demo',
          configSnapshot: { name: 'demo', title: 'Demo' },
          addedAt: '2026-03-29T00:00:00.000Z',
          updatedAt: '2026-03-29T00:00:00.000Z'
        }
      }
    }
    const localBindings = {
      version: 1,
      deviceId: 'device-1',
      updatedAt: '2026-03-29T00:00:00.000Z',
      bindings: {
        demo: {
          name: 'demo',
          projectPath: '/workspace/demo',
          configPath: '/workspace/demo/plugin.json',
          status: 'ready',
          lastValidatedAt: '2026-03-29T00:00:00.000Z',
          updatedAt: '2026-03-29T00:00:00.000Z'
        }
      }
    }

    const result = upsertDevProjectFromConfig({
      registry,
      localBindings,
      pluginPath: '/workspace/other',
      pluginConfig: { name: 'demo', title: 'Demo', version: '1.0.0' }
    })

    expect(result.success).toBe(false)
    expect(result.reason).toContain('/workspace/demo')
  })

  it('rejects upsert for built-in plugin names', () => {
    const registry = { version: 2, projects: {} }
    const localBindings = { version: 1, deviceId: 'device-1', updatedAt: '', bindings: {} }

    const result = upsertDevProjectFromConfig({
      registry,
      localBindings,
      pluginPath: '/workspace/setting',
      pluginConfig: { name: 'setting', title: 'Setting', version: '1.0.0' }
    })

    expect(result.success).toBe(false)
    expect(result.reason).toMatch(/not allowed/)
  })

  it('binds the device when registry entry exists but local binding is missing', () => {
    const registry = {
      version: 2,
      projects: {
        demo: {
          name: 'demo',
          configSnapshot: { name: 'demo', version: '0.5.0' },
          addedAt: '2026-03-29T00:00:00.000Z',
          updatedAt: '2026-03-29T00:00:00.000Z'
        }
      }
    }
    const localBindings = { version: 1, deviceId: 'device-1', updatedAt: '', bindings: {} }

    const result = upsertDevProjectFromConfig({
      registry,
      localBindings,
      pluginPath: '/workspace/demo',
      pluginConfig: { name: 'demo', title: 'Demo', version: '1.0.0' },
      now: () => '2026-03-29T05:00:00.000Z'
    })

    expect(result.success).toBe(true)
    const binding = result.localBindings.bindings.demo
    expect(binding.projectPath).toBe('/workspace/demo')
    expect(binding.configPath).toBe('/workspace/demo/plugin.json')
    expect(binding.status).toBe('ready')
    expect(binding.lastValidatedAt).toBe('2026-03-29T05:00:00.000Z')
    expect(result.registry.projects.demo.configSnapshot.version).toBe('1.0.0')
  })

  it('rejects import when plugin configuration lacks name', () => {
    const registry = { version: 2, projects: {} }
    const localBindings = { version: 1, deviceId: 'device-1', updatedAt: '', bindings: {} }

    const result = upsertDevProjectFromConfig({
      registry,
      localBindings,
      pluginPath: '/workspace/nameless',
      pluginConfig: { title: 'Nameless' }
    })

    expect(result.success).toBe(false)
    expect(result.reason).toMatch(/requires a name/)
  })

  it('allows packaging ready projects even when dev mode is not installed', () => {
    const binding = {
      name: 'demo',
      projectPath: '/workspace/demo',
      configPath: '/workspace/demo/plugin.json',
      status: 'ready',
      lastValidatedAt: '2026-03-29T00:00:00.000Z',
      updatedAt: '2026-03-29T00:00:00.000Z'
    }
    expect(canPackageDevProject(binding)).toBe(true)
  })

  it.each(['config_missing', 'invalid_config', 'unbound'] as const)(
    'does not allow packaging when binding status is %s',
    (status) => {
      const binding = {
        name: 'demo',
        projectPath: '/workspace/demo',
        configPath: '/workspace/demo/plugin.json',
        status,
        lastValidatedAt: '2026-03-29T00:00:00.000Z',
        updatedAt: '2026-03-29T00:00:00.000Z'
      }
      expect(canPackageDevProject(binding)).toBe(false)
    }
  )

  it('rejects repair selections when config name does not match registry', () => {
    const registryItem = {
      name: 'demo',
      configSnapshot: { name: 'demo' },
      addedAt: '',
      updatedAt: ''
    }
    expect(validateRepairConfigSelection(registryItem, { name: 'other' })).toBe(false)
  })

  it('normalizes invalid registry docs into an empty v2 payload', () => {
    const registry = readDevPluginRegistryDoc({ version: 1, projects: [] })
    expect(registry).toEqual({ version: 2, projects: {} })
  })

  it('drops invalid and built-in entries when normalizing registry docs', () => {
    const registry = readDevPluginRegistryDoc({
      version: 2,
      projects: {
        demo: {
          name: 'demo',
          configSnapshot: { name: 'demo', title: 'Demo' },
          addedAt: '2026-03-29T00:00:00.000Z',
          updatedAt: '2026-03-29T01:00:00.000Z'
        },
        setting: {
          name: 'setting',
          configSnapshot: { name: 'setting', title: 'Setting' },
          addedAt: '2026-03-29T00:00:00.000Z',
          updatedAt: '2026-03-29T01:00:00.000Z'
        },
        bad: {
          configSnapshot: { name: 'bad' }
        }
      }
    })

    expect(Object.keys(registry.projects)).toEqual(['demo'])
  })

  it('normalizes bindings with mismatched device id as an empty local doc', () => {
    const bindings = readDevPluginLocalBindingsDoc(
      {
        version: 1,
        deviceId: 'other-device',
        updatedAt: '2026-03-29T00:00:00.000Z',
        bindings: {
          demo: {
            name: 'demo',
            projectPath: '/workspace/demo',
            configPath: '/workspace/demo/plugin.json',
            status: 'ready',
            lastValidatedAt: '2026-03-29T00:00:00.000Z',
            updatedAt: '2026-03-29T00:00:00.000Z'
          }
        }
      },
      'device-1'
    )

    expect(bindings.deviceId).toBe('device-1')
    expect(bindings.bindings).toEqual({})
  })

  it('preserves unbound bindings with null paths and validation metadata', () => {
    const bindings = readDevPluginLocalBindingsDoc(
      {
        version: 1,
        deviceId: 'device-1',
        updatedAt: '2026-03-29T03:00:00.000Z',
        bindings: {
          demo: {
            name: 'demo',
            projectPath: null,
            configPath: null,
            status: 'unbound',
            lastValidatedAt: '2026-03-29T02:00:00.000Z',
            updatedAt: '2026-03-29T02:00:00.000Z',
            lastError: '项目未绑定到当前设备路径'
          }
        }
      },
      'device-1'
    )

    expect(bindings.bindings.demo).toEqual({
      name: 'demo',
      projectPath: null,
      configPath: null,
      status: 'unbound',
      lastValidatedAt: '2026-03-29T02:00:00.000Z',
      updatedAt: '2026-03-29T02:00:00.000Z',
      lastError: '项目未绑定到当前设备路径'
    })
  })

  it('falls back to addedAt order when sortOrder is missing', () => {
    const registry = readDevPluginRegistryDoc({
      version: 2,
      projects: {
        alpha: {
          name: 'alpha',
          configSnapshot: { name: 'alpha', version: '1.0.0' },
          addedAt: '2026-03-29T00:00:00.000Z',
          updatedAt: '2026-03-29T00:00:00.000Z'
        },
        beta: {
          name: 'beta',
          configSnapshot: { name: 'beta', version: '1.0.0' },
          addedAt: '2026-03-29T01:00:00.000Z',
          updatedAt: '2026-03-29T01:00:00.000Z'
        }
      }
    })

    expect(Object.values(registry.projects).map((item) => item.sortOrder)).toEqual([1, 0])
  })

  it('appends unseen projects when applying a stale order payload', () => {
    const next = applyDevProjectsOrderUpdate(
      {
        version: 2,
        projects: {
          alpha: {
            name: 'alpha',
            configSnapshot: { name: 'alpha' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 1
          },
          beta: {
            name: 'beta',
            configSnapshot: { name: 'beta' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 0
          },
          gamma: {
            name: 'gamma',
            configSnapshot: { name: 'gamma' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 2
          }
        }
      },
      ['alpha', 'beta']
    )

    expect(
      Object.values(next.projects)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((item) => item.name)
    ).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('moves a newly imported project to the top of the shared order', () => {
    const next = insertDevProjectAtTop(
      {
        version: 2,
        projects: {
          alpha: {
            name: 'alpha',
            configSnapshot: { name: 'alpha' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 0
          },
          beta: {
            name: 'beta',
            configSnapshot: { name: 'beta' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 1
          }
        }
      },
      'beta'
    )

    expect(next.projects.beta?.sortOrder).toBe(0)
    expect(next.projects.alpha?.sortOrder).toBe(1)
  })

  it('keeps the top-inserted order stable after a reorder payload is applied', () => {
    const inserted = insertDevProjectAtTop(
      {
        version: 2,
        projects: {
          alpha: {
            name: 'alpha',
            configSnapshot: { name: 'alpha' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 0
          },
          beta: {
            name: 'beta',
            configSnapshot: { name: 'beta' },
            addedAt: '',
            updatedAt: '',
            sortOrder: 1
          }
        }
      },
      'beta'
    )

    const reordered = applyDevProjectsOrderUpdate(inserted, ['alpha', 'beta'])

    expect(
      Object.values(reordered.projects)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((item) => item.name)
    ).toEqual(['alpha', 'beta'])
  })
})
