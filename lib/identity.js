import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json')

export const PACKAGE_NAME = packageJson.name
export const PACKAGE_VERSION = packageJson.version
export const THREAD_SOURCE = 'dsh_oh_my_codex'
export const CLIENT_INFO = Object.freeze({
  name: PACKAGE_NAME,
  title: 'DSH Oh My Codex',
  version: PACKAGE_VERSION,
})
