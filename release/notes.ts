/**
 * Prints the notes of a release, taken from its `CHANGELOG.md` entry, for the GitHub release
 * that `.github/workflows/release.yml` creates: `npx tsx release/notes.ts <version>`.
 */
import { readFileSync } from 'node:fs'

import { isNormalizedError, noThrow } from '../utilities/no-throw'

import { extractReleaseNotes } from './changelog'

const notes = noThrow(() => {
  const version = process.argv.at(2)
  if (version === undefined) {
    throw new Error('🚨 usage: npx tsx release/notes.ts <version>')
  }
  return extractReleaseNotes(readFileSync('CHANGELOG.md', 'utf8'), version)
})

if (isNormalizedError(notes)) {
  console.error(notes.message)
  process.exitCode = 1
} else {
  process.stdout.write(notes)
}
