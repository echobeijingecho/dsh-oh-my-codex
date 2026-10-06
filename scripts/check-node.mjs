const required = [22, 19, 0]
const actual = process.versions.node.split('.').map(Number)

const compatible = actual[0] > required[0]
  || (actual[0] === required[0] && (
    actual[1] > required[1]
    || (actual[1] === required[1] && actual[2] >= required[2])
  ))

if (!compatible) {
  console.error(`dsh-oh-my-codex requires Node.js >= ${required.join('.')}; found ${process.versions.node}`)
  console.error('Use the version in .nvmrc before running the test suite.')
  process.exit(1)
}
