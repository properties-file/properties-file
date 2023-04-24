# V2 to V3 migration guide

## Overview

Version 3 is a major change since it includes the new `PropertiesEditor` class. We took this opportunity to make the following improvements the existing APIs:

- The `getProperties` API has been replaced by the `Properties` object.
- `propertiesToJson` has been renamed to `getProperties` for the sake of naming clarity.
- To simplify our APIs, we no longer support file paths as parameters but only `.properties` content.

## Migration steps

Because we are re-using the `getProperties` name for our `propertiesToJson` replacement API, we suggest to migrate this one first if you are using it to avoid naming clashes.

### Migrating `getProperties` from `properties-file`

_V2_

```ts
import { getProperties } from 'properties-file'

const properties = getProperties('assets/tests/collisions-test.properties')

properties.collection.forEach((property) => {
  console.log(`${property.key} => '${property.value}'`)
})
```

_V3_

```ts
import { readFileSync } from 'node:fs'
import { Properties } from 'properties-file'

const properties = new Properties(readFileSync('assets/tests/collisions-test.properties')))

properties.collection.forEach((property) => {
  console.log(`${property.key} => '${property.value}'`)
})
```

### Migrating `getProperties` from `properties-file/content`

_V2_

```ts
import { getProperties } from 'properties-file/content'

const properties = getProperties('hello = hello\n# This is a comment\nworld = world')

properties.collection.forEach((property) => {
  console.log(`${property.key} => '${property.value}'`)
})
```

_V3_

```ts
import { Properties } from 'properties-file'

const properties = new Properties('hello = hello\n# This is a comment\nworld = world')

properties.collection.forEach((property) => {
  console.log(`${property.key} => '${property.value}'`)
})
```

### Migrating `propertiesToJson` from `properties-file`

_V2_

```ts
import { propertiesToJson } from 'properties-file'

console.log(propertiesToJson('hello-world.properties'))
```

_V3_

```ts
import { readFileSync } from 'node:fs'
import { getProperties } from 'properties-file'

console.log(getProperties(readFileSync('hello-world.properties')))
```

### Migrating `propertiesToJson` from `properties-file/content`

_V2_

```ts
import { propertiesToJson } from 'properties-file/content'

console.log(propertiesToJson('hello = hello\n# This is a comment\nworld = world'))
```

_V3_

```ts
import { getProperties } from 'properties-file'

console.log(getProperties('hello = hello\n# This is a comment\nworld = world'))
```
