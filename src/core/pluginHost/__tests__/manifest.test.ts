import { describe, it, expect } from 'vitest'
import { parseManifest, ManifestError } from '../manifest'

describe('parseManifest', () => {
  const validPkg = {
    name: 'papershore',
    version: '0.3.0',
    main: 'dist/tinstar-plugin.js',
    tinstar: {
      apiVersion: '5',
      displayName: 'Papershore',
    },
  }

  it('returns name, version, and manifest for a valid package.json', () => {
    const r = parseManifest(validPkg)
    expect(r.name).toBe('papershore')
    expect(r.version).toBe('0.3.0')
    expect(r.manifest.apiVersion).toBe('5')
    expect(r.manifest.displayName).toBe('Papershore')
  })

  it('throws ManifestError when package.json is not an object', () => {
    expect(() => parseManifest(null)).toThrow(ManifestError)
    expect(() => parseManifest('hello')).toThrow(ManifestError)
  })

  it('throws when name is missing, wrong type, or empty', () => {
    expect(() => parseManifest({ ...validPkg, name: undefined })).toThrow(/name/)
    expect(() => parseManifest({ ...validPkg, name: 42 })).toThrow(/name/)
    expect(() => parseManifest({ ...validPkg, name: '' })).toThrow(/name/)
  })

  it('throws when version is missing or not a string', () => {
    expect(() => parseManifest({ ...validPkg, version: undefined })).toThrow(/version/)
    expect(() => parseManifest({ ...validPkg, version: 42 })).toThrow(/version/)
  })

  it('throws when tinstar manifest is missing', () => {
    expect(() => parseManifest({ name: 'x', version: '0.0.1' })).toThrow(/missing tinstar manifest/)
  })

  it('throws on apiVersion mismatch', () => {
    expect(() => parseManifest({ ...validPkg, tinstar: { apiVersion: '4', displayName: 'P' } }))
      .toThrow(/apiVersion 4.*expected 5/)
    expect(() => parseManifest({ ...validPkg, tinstar: { apiVersion: '6', displayName: 'P' } }))
      .toThrow(/apiVersion 6.*expected 5/)
  })

  it('throws when displayName is missing or empty', () => {
    expect(() => parseManifest({ ...validPkg, tinstar: { apiVersion: '5' } })).toThrow(/displayName/)
    expect(() => parseManifest({ ...validPkg, tinstar: { apiVersion: '5', displayName: '' } })).toThrow(/displayName/)
  })

  it('rejects an array tinstar field via the apiVersion path', () => {
    expect(() => parseManifest({ ...validPkg, tinstar: [] })).toThrow(ManifestError)
  })

  it('accepts optional contributes and permissions', () => {
    const r = parseManifest({
      ...validPkg,
      tinstar: {
        apiVersion: '5',
        displayName: 'Papershore',
        contributes: { widgets: [{ type: 'board', label: 'Board' }] },
        permissions: ['tasks:read'],
      },
    })
    expect(r.manifest.contributes?.widgets?.[0]?.type).toBe('board')
    expect(r.manifest.permissions).toEqual(['tasks:read'])
  })
})

describe('parseManifest contributes.widgets new fields', () => {
  it('accepts the new optional fields', () => {
    const parsed = parseManifest({
      name: 'fixture-plugin',
      version: '0.1.0',
      tinstar: {
        apiVersion: '5',
        displayName: 'Fixture',
        contributes: {
          widgets: [{
            type: 'fixture-widget',
            label: 'Fixture',
            defaultSize: { width: 300, height: 200 },
            description: 'A test widget.',
            icon: './icon.svg',
            singleton: true,
            spawn: 'palette',
            creator: 'session-backed',
            capabilities: ['browser'],
            tags: ['dev', 'web'],
            snappable: false,
          }],
        },
      },
    })
    const w = parsed.manifest.contributes?.widgets?.[0]
    expect(w?.description).toBe('A test widget.')
    expect(w?.singleton).toBe(true)
    expect(w?.spawn).toBe('palette')
    expect(w?.creator).toBe('session-backed')
    expect(w?.capabilities).toEqual(['browser'])
    expect(w?.tags).toEqual(['dev', 'web'])
    expect(w?.snappable).toBe(false)
  })

  it('rejects non-boolean snappable', () => {
    expect(() => parseManifest({
      name: 'p', version: '1', tinstar: {
        apiVersion: '5', displayName: 'P',
        contributes: { widgets: [{ type: 't', label: 'T', snappable: 'yes' }] },
      },
    })).toThrow(/snappable/)
  })

  it('rejects unknown creator values', () => {
    expect(() => parseManifest({
      name: 'p', version: '1', tinstar: {
        apiVersion: '5', displayName: 'P',
        contributes: { widgets: [{ type: 't', label: 'T', creator: 'foo' }] },
      },
    })).toThrow(/creator/)
  })

  it('rejects non-string-array capabilities', () => {
    expect(() => parseManifest({
      name: 'p', version: '1', tinstar: {
        apiVersion: '5', displayName: 'P',
        contributes: { widgets: [{ type: 't', label: 'T', capabilities: [123] }] },
      },
    })).toThrow(/capabilities/)
  })

  it('rejects non-array tags', () => {
    expect(() => parseManifest({
      name: 'p', version: '1', tinstar: {
        apiVersion: '5', displayName: 'P',
        contributes: { widgets: [{ type: 't', label: 'T', tags: 'dev' }] },
      },
    })).toThrow(/tags/)
  })

  it('rejects unknown spawn values', () => {
    expect(() => parseManifest({
      name: 'p', version: '1', tinstar: {
        apiVersion: '5', displayName: 'P',
        contributes: { widgets: [{ type: 't', label: 'T', spawn: 'invalid-mode' }] },
      },
    })).toThrow(/spawn/)
  })

  it('rejects non-boolean singleton', () => {
    expect(() => parseManifest({
      name: 'p', version: '1', tinstar: {
        apiVersion: '5', displayName: 'P',
        contributes: { widgets: [{ type: 't', label: 'T', singleton: 'true' }] },
      },
    })).toThrow(/singleton/)
  })

  it('rejects non-string description', () => {
    expect(() => parseManifest({
      name: 'p', version: '1', tinstar: {
        apiVersion: '5', displayName: 'P',
        contributes: { widgets: [{ type: 't', label: 'T', description: 42 }] },
      },
    })).toThrow(/description/)
  })

  it('rejects non-string icon', () => {
    expect(() => parseManifest({
      name: 'p', version: '1', tinstar: {
        apiVersion: '5', displayName: 'P',
        contributes: { widgets: [{ type: 't', label: 'T', icon: 123 }] },
      },
    })).toThrow(/icon/)
  })

  it('rejects missing widget type', () => {
    expect(() => parseManifest({
      name: 'p', version: '1', tinstar: {
        apiVersion: '5', displayName: 'P',
        contributes: { widgets: [{ label: 'T' }] },
      },
    })).toThrow(/type/)
  })

  it('rejects missing widget label', () => {
    expect(() => parseManifest({
      name: 'p', version: '1', tinstar: {
        apiVersion: '5', displayName: 'P',
        contributes: { widgets: [{ type: 't' }] },
      },
    })).toThrow(/label/)
  })

  it('rejects malformed defaultSize', () => {
    expect(() => parseManifest({
      name: 'p', version: '1', tinstar: {
        apiVersion: '5', displayName: 'P',
        contributes: { widgets: [{ type: 't', label: 'T', defaultSize: { width: 100 } }] },
      },
    })).toThrow(/defaultSize/)
  })

  it('accepts a manifest with no widgets contribution', () => {
    expect(() => parseManifest({
      name: 'p', version: '1', tinstar: { apiVersion: '5', displayName: 'P' },
    })).not.toThrow()
  })
})

describe('manifest anchors validation', () => {
  const base = (widget: object) => ({
    name: 'p', version: '1.0.0',
    tinstar: { apiVersion: '5', displayName: 'P', contributes: { widgets: [widget] } },
  })

  it('accepts a valid anchors array', () => {
    const m = parseManifest(base({ type: 't', label: 'T', anchors: [{ name: 'a', x: 0, y: 0 }] }))
    expect(m.manifest.contributes!.widgets![0]!.anchors).toEqual([{ name: 'a', x: 0, y: 0 }])
  })
  it('rejects anchors with out-of-range coords', () => {
    expect(() => parseManifest(base({ type: 't', label: 'T', anchors: [{ name: 'a', x: 5, y: 0 }] })))
      .toThrow(ManifestError)
  })
  it('rejects a non-array anchors', () => {
    expect(() => parseManifest(base({ type: 't', label: 'T', anchors: 'nope' }))).toThrow(ManifestError)
  })
})
