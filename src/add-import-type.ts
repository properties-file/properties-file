/**
 * These extra steps are required after the build to pass the correct type when importing `.properties` file directly.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Add a type reference to another type file.
 *
 * @param typeFilePath - The type file path where to add the reference.
 * @param typeReferenceFilePath - The type reference path being added.
 */
const addReference = (typeFilePath: string, typeReferenceFilePath: string): void => {
  writeFileSync(
    typeFilePath,
    `/// <reference types="${typeReferenceFilePath}" />\r\n${readFileSync(typeFilePath).toString()}`
  )
}

/**
 * Since the type file to open `.properties` files is not a module and cannot be copied, we need to
 * copy it explicitly after the build.
 */
const declarationFilename = 'properties-file'
const typeFileContent = readFileSync(`./src/${declarationFilename}.d.ts`).toString()
writeFileSync(`./lib/${declarationFilename}.d.ts`, typeFileContent)

/**
 * Now that the declaration file is copied, we can reference it in the main package's module types.
 */
const packageTypesFilePath = './lib/index.d.ts'
addReference(packageTypesFilePath, `./${declarationFilename}`)

/**
 * Since the most common use case to support to require the file type declaration is by configuring
 * a loader, we need to also add the reference in all available loaders.
 *
 * @see https://github.com/microsoft/TypeScript/issues/49124
 * @see https://stackoverflow.com/questions/72187763/how-to-include-a-global-file-type-declaration-in-a-typescript-node-js-package
 */

const fileLoaderDirectoryPath = './lib/loader'
const fileLoaderFilePaths = readdirSync(fileLoaderDirectoryPath)

fileLoaderFilePaths.forEach((fileLoaderFilePath) => {
  if (fileLoaderFilePath.endsWith('d.ts')) {
    addReference(`${fileLoaderDirectoryPath}/${fileLoaderFilePath}`, `../${declarationFilename}`)
  }
})
