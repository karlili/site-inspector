// Fails if any source file uses a rounded-* utility other than rounded-none.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const offenders = []
// Any rounded-* except rounded-none, or a bare `rounded` class at the edge of a class string.
const pattern = /\brounded-(?!none\b)[\w[\].-]+|(?<=["'`])rounded(?=[\s"'`])|(?<=\s)rounded(?=["'`])/g

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) walk(file)
    else if (/\.(tsx?|css)$/.test(name) && !name.endsWith('.gen.ts')) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const match of line.matchAll(pattern)) offenders.push(`${file}:${i + 1}  ${match[0]}`)
        })
    }
  }
}

walk('src')
if (offenders.length) {
  console.error('Rounded corners are not allowed:\n' + offenders.join('\n'))
  process.exit(1)
}
console.log('No rounded corners found.')
