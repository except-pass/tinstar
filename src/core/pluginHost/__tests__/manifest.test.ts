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
    expect(r.manifest.contributes?.widgets?.[0].type).toBe('board')
    expect(r.manifest.permissions).toEqual(['tasks:read'])
  })
})
