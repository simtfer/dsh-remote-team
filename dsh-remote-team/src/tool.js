/**
 * A tiny dependency-free equivalent of DSH's defineTool() for third-party
 * bundles. ctx.tools.register() accepts a raw ToolDefinition; we produce one
 * with a JSON Schema parameter object, a canonical output projection, and a
 * lightweight required-field check in execute().
 */

function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(spec ?? {})) {
    const field = { ...raw }
    const isRequired = field.required === true
    delete field.required
    properties[key] = field
    if (isRequired) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

function checkRequired(args, schema) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('tool arguments must be an object')
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) {
      throw new Error(`missing required argument "${key}"`)
    }
  }
  const allowed = new Set(Object.keys(schema.properties))
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new Error(`unexpected argument "${key}"`)
  }
}

/**
 * Build a ToolDefinition-shaped object.
 * @param {object} options - name, description, parameters (short spec), execute, outputSchema
 */
export function defineTool(options) {
  const parameters = toJsonSchema(options.parameters)
  const outputSchema = options.outputSchema ?? { type: 'object', additionalProperties: true }
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(_args, value) {
        const text = typeof value === 'string' ? value : JSON.stringify(value)
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      checkRequired(args, parameters)
      return options.execute(args, exec)
    },
    isConcurrencySafe: options.isConcurrencySafe ?? (() => false),
  }
}

/** Extract plain text from a SubagentResult.output content block array. */
export function textOfOutput(output) {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return output
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}
