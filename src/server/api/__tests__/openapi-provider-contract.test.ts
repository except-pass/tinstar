import { describe, expect, it } from 'vitest'
import { spec } from '../openapi'

describe('OpenAPI provider/template contract', () => {
  it('documents stable template discovery and persisted session identity', () => {
    const schemas = spec.components.schemas

    expect(spec.paths['/api/cli-templates']?.get).toBeDefined()
    expect(spec.paths['/api/cli-templates/{id}']?.put).toBeDefined()
    expect(spec.paths['/api/cli-templates'].post.responses[200].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/CliTemplateResponse' })
    expect(spec.paths['/api/cli-templates/{id}'].put.responses[200].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/CliTemplateResponse' })
    expect(spec.paths['/api/cli-templates/{id}'].delete.responses[200].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/NullResponse' })
    expect(schemas.CliTemplate).toBeDefined()
    expect(schemas.CliTemplateResponse.properties.data)
      .toEqual({ $ref: '#/components/schemas/CliTemplate' })
    expect(schemas.EntitySettings.properties.cliTemplate).toBeDefined()
    expect(schemas.Session.properties.cliTemplate).toBeDefined()
    expect(schemas.Session.properties.adapter).toBeDefined()
    expect(schemas.State.properties.sessions).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/Session' },
    })
  })
})
