import {JSONSchema} from "json-schema-to-typescript";

const hydraSpec: {[key: string]: JSONSchema} = {
  'HydraOperation': {
    title: 'Hydra Operation',
    type: 'object',
    required: ['statusCodes', 'method'],
    additionalProperties: false,
    properties: {
      method: { type: 'string' },
      expects: { type: 'string' },
      returns: { type: 'string' },
      statusCodes: { type: 'array', items: { type: 'string'} },
    }
  },
  'HydraResource': {
    title: 'Hydra Resource',
    type: 'object',
    additionalProperties: false,
    properties: {
      '@id': { type: 'string' },
      '@operation': { type: 'array', items: { $ref: '#/components/schemas/HydraOperation' } }
    }
  },
  'HydraCollection': {
    title: 'Hydra Collection',
    allOf: [
      { $ref: '#/components/schemas/HydraResource' },
      { type: 'object', properties: { member: { type: 'array', items: { $ref: '#/components/schemas/HydraResource' }}} }
    ]
  }
}

export default hydraSpec;
