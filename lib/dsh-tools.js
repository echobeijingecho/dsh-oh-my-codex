import { createHash } from 'node:crypto'

export const NAMESPACE = 'dsh'
const NAME_LIMIT = 64
const VALID_NAME = /^[A-Za-z0-9_-]+$/

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

export function matcher(patterns = []) {
  const compiled = patterns.map(globToRegExp)
  return name => compiled.some(regexp => regexp.test(name))
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 10)
}

/**
 * Codex reserves the `mcp__` prefix for its own MCP servers, and function names
 * must fit the model API limits. Aliases are deterministic for a given tool set:
 * ordinary valid names stay unchanged; everything else is rewritten and, on a
 * collision or length overflow, suffixed with a hash of the original name.
 */
export function aliasTools(names) {
  const aliases = new Map()
  const taken = new Set()
  const ordinary = names.filter(name => !name.startsWith('mcp__') && VALID_NAME.test(name) && name.length <= NAME_LIMIT)
  for (const name of ordinary) { aliases.set(name, name); taken.add(name) }
  for (const name of names) {
    if (aliases.has(name)) continue
    let base = name.startsWith('mcp__') ? `dsh_mcp__${name.slice(5)}` : name
    base = base.replace(/[^A-Za-z0-9_-]/g, '_')
    let alias = base.length <= NAME_LIMIT ? base : `${base.slice(0, NAME_LIMIT - 11)}_${digest(name)}`
    if (taken.has(alias)) alias = `${base.slice(0, NAME_LIMIT - 11)}_${digest(name)}`
    for (let n = 2; taken.has(alias); n += 1) alias = `${base.slice(0, NAME_LIMIT - 11 - String(n).length - 1)}_${digest(name)}_${n}`
    aliases.set(name, alias)
    taken.add(alias)
  }
  return aliases
}

/**
 * Project the DSH tools a deployment allowlists into one Codex dynamic-tool
 * namespace. Calls come back through `ctx.tools.execute`, so DSH policies
 * (approval presets, masking, audit) run exactly as for a native model call.
 */
export function buildDynamicTools(schemas, include, forced = []) {
  const allowed = matcher(include)
  // Forced names ride outside the allowlist glob (they must be declared at
  // thread creation, before anyone knows a /plan is coming) but still require
  // the host to have registered them.
  const force = new Set(forced)
  const visible = schemas
    .filter(schema => schema && typeof schema.name === 'string' && (allowed(schema.name) || force.has(schema.name)))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (!visible.length) return { specs: undefined, resolve: () => undefined, names: [] }
  const aliases = aliasTools(visible.map(schema => schema.name))
  const original = new Map([...aliases].map(([name, alias]) => [alias, name]))
  return {
    names: visible.map(schema => schema.name),
    specs: [{
      type: 'namespace',
      name: NAMESPACE,
      description: 'Governed DSH tools. Prefer these for company data: DSH applies permission presets, approvals, masking and audit to every call.',
      tools: visible.map(schema => ({
        type: 'function',
        name: aliases.get(schema.name),
        description: String(schema.description ?? '').slice(0, 4000),
        inputSchema: schema.parameters && typeof schema.parameters === 'object'
          ? schema.parameters : { type: 'object', properties: {} },
      })),
    }],
    resolve: alias => original.get(alias),
  }
}

function contentText(content) {
  return (content ?? []).map(block => {
    if (block?.type === 'text') return block.text
    if (block?.type === 'image') return '[image omitted]'
    return JSON.stringify(block)
  }).join('\n')
}

/** Map one DSH tool result onto the Codex dynamic-tool response contract. */
export function dynamicToolResponse(result) {
  const text = contentText(result?.content)
  return {
    contentItems: [{ type: 'inputText', text: text || (result?.isError ? 'Tool failed.' : '') }],
    success: result?.isError !== true,
  }
}
