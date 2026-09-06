export type TrainingSchema = Record<string, unknown>

type SchemaProperty = {
  type?: unknown
  enum?: unknown
  default?: unknown
  minimum?: unknown
  maximum?: unknown
  exclusiveMinimum?: unknown
}

function schemaProperties(schema: TrainingSchema): Record<string, SchemaProperty> {
  const properties = schema.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {}
  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) =>
      Boolean(value && typeof value === 'object' && !Array.isArray(value))
    )
  ) as Record<string, SchemaProperty>
}

/**
 * Preserve only scalar values explicitly declared by STRUM's schema. This is
 * the main-process boundary between renderer intent and a worker invocation;
 * unknown renderer fields never reach STRUM.
 */
export function sanitizeTrainingSchemaValues(
  schema: TrainingSchema,
  requested: Record<string, unknown>,
  label: string
): Record<string, string | number | boolean | null> {
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    throw new Error(`STRUM rejected invalid ${label} options.`)
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : []
  )
  const sanitized: Record<string, string | number | boolean | null> = {}
  for (const [key, property] of Object.entries(schemaProperties(schema))) {
    const hasRequestedValue = Object.prototype.hasOwnProperty.call(requested, key)
    const value = hasRequestedValue ? requested[key] : property.default
    if (value === undefined) {
      if (required.has(key)) {
        throw new Error(`STRUM requires a ${label} value for ${key.replaceAll('_', ' ')}.`)
      }
      continue
    }
    const types = Array.isArray(property.type) ? property.type : [property.type]
    const validType = types.some(
      (type) =>
        (type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
        (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
        (type === 'boolean' && typeof value === 'boolean') ||
        (type === 'string' && typeof value === 'string') ||
        (type === 'null' && value === null)
    )
    if (
      !validType ||
      !(
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      )
    ) {
      throw new Error(`STRUM rejected an invalid ${label} value.`)
    }
    if (Array.isArray(property.enum) && !property.enum.some((allowed) => allowed === value)) {
      throw new Error(`STRUM rejected an unsupported ${label} value.`)
    }
    if (
      typeof value === 'number' &&
      ((typeof property.minimum === 'number' && value < property.minimum) ||
        (typeof property.maximum === 'number' && value > property.maximum) ||
        (typeof property.exclusiveMinimum === 'number' && value <= property.exclusiveMinimum))
    ) {
      throw new Error(`STRUM rejected an out-of-range ${label} value.`)
    }
    sanitized[key] = value
  }
  return sanitized
}
