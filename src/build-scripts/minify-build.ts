import { glob } from 'glob'
import { readFileSync, writeFileSync } from 'node:fs'
import { EOL } from 'node:os'
import { minify } from 'terser'

const targetPattern = 'lib/{esm,cjs}/**/*.js'

console.log(`${EOL}🏃 Running build script: minify build.${EOL}`)

glob(targetPattern)
  .then((files) =>
    files.forEach((file) => {
      void minify(readFileSync(file).toString())
        .then((result) => {
          if (result?.code === undefined) {
            throw new Error('Minification failed')
          }
          console.log(`   📦 Minifying file: ${file}`)
          writeFileSync(file, result.code)
        })
        .catch((error) => {
          console.error(`🚨 Error minifying file: ${file}${EOL}`)
          console.error(error)
        })
    })
  )
  .catch((error) => {
    console.error(`🚨 Error reading files from ${targetPattern}${EOL}`)
    console.error(error)
  })
