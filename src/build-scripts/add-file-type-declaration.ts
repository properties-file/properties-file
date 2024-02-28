/**
 * This build script is meant to be run after the build to add the correct type reference when
 * importing `.properties` files directly.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { EOL } from 'node:os'

console.log(`🏃 Running build script: add file type declaration.${EOL}`)

/**
 * Adds a type reference to another type file at the top of the target file.
 *
 * @param targetTypeFilePath - The path of the target file where the type reference will be added.
 * @param typeReferenceFilePath - The path of the type file to reference, without the file extension.
 */
const addTypeReference = (targetTypeFilePath: string, typeReferenceFilePath: string): void => {
  console.log(`   🔗 Adding type reference (${typeReferenceFilePath}) to ${targetTypeFilePath}`)
  writeFileSync(
    targetTypeFilePath,
    `/// <reference types="${typeReferenceFilePath}" />\r\n${readFileSync(targetTypeFilePath).toString()}`
  )
}

// Since the package supports both CommonJS and ECMAScript modules, we need to add the type reference to both.
const modulePaths = ['./lib/cjs', './lib/esm']

/**
 * Since the type file to open `.properties` files is not a module and cannot be copied, we need to
 * copy it explicitly after the build.
 */
const declarationFilename = 'properties-file'
const typeFileContent = readFileSync(`./src/${declarationFilename}.d.ts`).toString()
modulePaths.forEach((modulePath) => {
  console.log(
    `   🧬 Copying ./src/${declarationFilename}.d.ts to ${modulePath}/${declarationFilename}.d.ts`
  )
  writeFileSync(`${modulePath}/${declarationFilename}.d.ts`, typeFileContent)
})

/**
 * Now that the declaration file is copied, we can reference it in the main package's module types.
 */
const packageTypesFilePath = 'index.d.ts'
modulePaths.forEach((modulePath) => {
  addTypeReference(`${modulePath}/${packageTypesFilePath}`, `./${declarationFilename}`)
})

/**
 * Since the most common use case to support to require the file type declaration is by configuring
 * a loader, we need to also add the reference in all available loaders.
 *
 * @see https://github.com/microsoft/TypeScript/issues/49124
 * @see https://stackoverflow.com/questions/72187763/how-to-include-a-global-file-type-declaration-in-a-typescript-node-js-package
 */

modulePaths.forEach((modulePath) => {
  const fileLoaderDirectoryPath = `${modulePath}/loader`
  const fileLoaderFilePaths = readdirSync(fileLoaderDirectoryPath)
  fileLoaderFilePaths.forEach((fileLoaderFilePath) => {
    if (fileLoaderFilePath.endsWith('d.ts')) {
      addTypeReference(
        `./${fileLoaderDirectoryPath}/${fileLoaderFilePath}`,
        `../${declarationFilename}`
      )
    }
  })
})
