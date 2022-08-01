/** This allows to get the correct type when using `import` on `.properties` files. */
declare module '*.properties' {
  const properties: {
    readonly [key: string]: string
  }
  export default properties
}
