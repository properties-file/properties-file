declare module '*.properties' {
  /** A key/value object representing the content of a `.properties` file. */
  const keyValuePairObject: {
    /** The value of a `.properties` file key. */
    readonly [key: string]: string
  }
  export = keyValuePairObject
}
