/**
 * Functional behavioral test replay runner — CommonJS / ES5 edition.
 *
 * Loads the scenario matrix from `golden.json` (generated from source by
 * `generate.ts`) and replays every scenario against the compiled `dist/cjs`
 * artifacts, deep-comparing actual output against the expected output that was
 * captured from the TypeScript source.
 *
 * Strict ES5 discipline: this file must execute unmodified on Node.js 0.4.0 (the
 * oldest supported runtime), so it is run directly inside the Docker container
 * used by `npm run test-node-compat`. Only `var`, `function`, and ES5 built-ins
 * are used — no arrow functions, template literals, `const`/`let`,
 * destructuring, spread, `for...of`, `Object.assign`, `Array.prototype.includes`,
 * or Promises.
 *
 * This is the one file in the repository that cannot be TypeScript: Node.js 0.4
 * predates every TypeScript runtime, and shipping a compiled copy would defeat
 * the point of a dependency-free runner that exercises the real published
 * artifacts. Because plain ES5 violates most of the repository's lint rules by
 * design, the file is excluded from ESLint (see the ignore list in
 * `eslint/config.ts`) and from GitHub language statistics (`linguist-vendored`
 * in `.gitattributes`). Its modern counterpart, `run-esm.mts`, IS TypeScript.
 *
 * Usage:
 *   node tests/functional/run-cjs.js [distRoot]
 *   node tests/functional/run-cjs.js --package-name
 *
 * By path (default): every entry point is loaded by file path from `distRoot`,
 * which defaults to `<repo>/dist/cjs` (resolved relative to this file) and can
 * be overridden to an absolute path (the Node.js 0.4.0 Docker container points
 * it at its installed copy of `dist/cjs`).
 *
 * By package name (`--package-name`): every entry point is loaded the way a
 * consumer loads it — `require('properties-file')`,
 * `require('properties-file/editor')`, … — resolved through a
 * `node_modules/properties-file` directory next to this file or above it. On a
 * runtime that predates the `exports` map (all of Node.js before 12.7, including
 * 0.4), that exercises the root `package.json` `main` field and the generated
 * legacy subpath stubs (`editor/package.json`, …; see
 * `src/build-scripts/generate-subpath-stubs.ts`), not just the compiled files.
 * The Docker container installs that layout and runs both modes. A subpath that
 * cannot be resolved fails loudly with the request that failed, before any
 * scenario runs.
 */

var fs = require('fs')
var path = require('path')

// ---------------------------------------------------------------------------
// Locate golden.json and the entry points
// ---------------------------------------------------------------------------

var PACKAGE_NAME = 'properties-file'
var isPackageNameMode = process.argv[2] === '--package-name'
var distRoot = isPackageNameMode
  ? null
  : process.argv[2] || path.join(__dirname, '..', '..', 'dist', 'cjs')
var goldenPath = path.join(__dirname, 'golden.json')

var scenarios = JSON.parse(fs.readFileSync(goldenPath, 'utf8'))

/**
 * Load one entry point, by file path from `distRoot`, or by package name.
 *
 * `subpath` is the public subpath (`''` for the root entry, `'editor'`, …) and
 * `distFile` the file it maps to inside `dist/cjs`. In package-name mode a
 * resolution failure exits immediately with the failing request, so a runtime
 * that cannot resolve the legacy layout is reported as exactly that rather than
 * as a generic stack trace.
 */
function loadEntryPoint(subpath, distFile) {
  if (!isPackageNameMode) {
    return require(path.join(distRoot, distFile))
  }
  var request = subpath === '' ? PACKAGE_NAME : PACKAGE_NAME + '/' + subpath
  try {
    return require(request)
  } catch (error) {
    console.log(
      '[run-cjs] Node ' +
        process.version +
        ': cannot load "' +
        request +
        '" by package name: ' +
        (error && error.message ? error.message : error)
    )
    console.log(
      '[run-cjs] Expected node_modules/' +
        PACKAGE_NAME +
        '/' +
        (subpath === '' ? 'package.json "main"' : subpath + '/package.json "main"') +
        ' to resolve to dist/cjs/' +
        distFile +
        ' — FAILED'
    )
    process.exit(1)
  }
}

var getProperties = loadEntryPoint('', 'index.js').getProperties
var Properties = loadEntryPoint('parser', 'parser/index.js').Properties
var PropertiesEditor = loadEntryPoint('editor', 'editor/index.js').PropertiesEditor
var escapeModule = loadEntryPoint('escape', 'escape/index.js')
var unescapeContent = loadEntryPoint('unescape', 'unescape/index.js').unescapeContent

// ---------------------------------------------------------------------------
// Deep equality (objects, arrays, primitives; key-set equality for objects)
// ---------------------------------------------------------------------------

function deepEqual(a, b) {
  if (a === b) {
    return true
  }
  if (typeof a !== typeof b) {
    return false
  }
  if (a === null || b === null) {
    return a === b
  }
  if (typeof a !== 'object') {
    return false
  }

  var aIsArray = Array.isArray(a)
  var bIsArray = Array.isArray(b)
  if (aIsArray !== bIsArray) {
    return false
  }

  if (aIsArray) {
    if (a.length !== b.length) {
      return false
    }
    for (var index = 0; index < a.length; index++) {
      if (!deepEqual(a[index], b[index])) {
        return false
      }
    }
    return true
  }

  var aKeys = Object.keys(a).sort()
  var bKeys = Object.keys(b).sort()
  if (aKeys.length !== bKeys.length) {
    return false
  }
  for (var keyIndex = 0; keyIndex < aKeys.length; keyIndex++) {
    if (aKeys[keyIndex] !== bKeys[keyIndex]) {
      return false
    }
  }
  for (var propertyIndex = 0; propertyIndex < aKeys.length; propertyIndex++) {
    var currentKey = aKeys[propertyIndex]
    if (!deepEqual(a[currentKey], b[currentKey])) {
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Node summarization (mirrors generate.ts's summarizeNode)
// ---------------------------------------------------------------------------

function summarizeNode(node) {
  if (node.type === 'property') {
    return {
      type: node.type,
      key: node.key,
      value: node.value,
      startingLineNumber: node.startingLineNumber,
    }
  }
  return { type: node.type, startingLineNumber: node.lineNumber }
}

function summarizeNodes(nodes) {
  var summarized = []
  for (var index = 0; index < nodes.length; index++) {
    summarized.push(summarizeNode(nodes[index]))
  }
  return summarized
}

// ---------------------------------------------------------------------------
// Per-kind interpreters
// ---------------------------------------------------------------------------

function runParseScenario(scenario) {
  var parsed = new Properties(scenario.input)
  return {
    object: getProperties(scenario.input),
    nodes: summarizeNodes(parsed.nodes),
    hasBom: parsed.hasBom,
  }
}

function runFormatScenario(scenario) {
  var properties = new Properties(scenario.input)
  return properties.format(scenario.options)
}

function applyEditorOperation(editor, operation) {
  switch (operation.method) {
    case 'insert': {
      editor.insert(operation.args[0], operation.args[1], operation.args[2])
      break
    }
    case 'update': {
      editor.update(operation.args[0], operation.args[1])
      break
    }
    case 'upsert': {
      editor.upsert(operation.args[0], operation.args[1], operation.args[2])
      break
    }
    case 'delete': {
      editor.delete(operation.args[0], operation.args[1])
      break
    }
    default: {
      throw new Error('Unknown editor method: ' + operation.method)
    }
  }
}

function runEditorScenario(scenario) {
  var editor = new PropertiesEditor(scenario.input)
  for (var index = 0; index < scenario.ops.length; index++) {
    applyEditorOperation(editor, scenario.ops[index])
  }
  return editor.format()
}

function runEscapeScenario(scenario) {
  var fn = escapeModule[scenario.fn]
  return fn(scenario.input, scenario.escapeUnicode)
}

function runUnescapeScenario(scenario) {
  return unescapeContent(scenario.input)
}

function runScenario(scenario) {
  switch (scenario.kind) {
    case 'parse': {
      return runParseScenario(scenario)
    }
    case 'format': {
      return runFormatScenario(scenario)
    }
    case 'editor': {
      return runEditorScenario(scenario)
    }
    case 'escape': {
      return runEscapeScenario(scenario)
    }
    case 'unescape': {
      return runUnescapeScenario(scenario)
    }
    default: {
      throw new Error('Unknown scenario kind: ' + scenario.kind)
    }
  }
}

// ---------------------------------------------------------------------------
// Run all scenarios
// ---------------------------------------------------------------------------

var modeLabel = isPackageNameMode ? 'by package name' : 'by path'
var passCount = 0
var failCount = 0

for (var scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex++) {
  var scenario = scenarios[scenarioIndex]
  var actual

  try {
    actual = runScenario(scenario)
  } catch (error) {
    failCount++
    console.log(
      'FAIL [' + scenario.id + ']: threw ' + (error && error.message ? error.message : error)
    )
    continue
  }

  if (deepEqual(actual, scenario.expected)) {
    passCount++
  } else {
    failCount++
    console.log('FAIL [' + scenario.id + ']')
    console.log('  expected: ' + JSON.stringify(scenario.expected))
    console.log('  actual:   ' + JSON.stringify(actual))
  }
}

if (failCount > 0) {
  console.log(
    '\n[run-cjs] Node ' +
      process.version +
      ' (' +
      modeLabel +
      '): ' +
      passCount +
      '/' +
      (passCount + failCount) +
      ' scenarios passed — FAILED'
  )
  process.exit(1)
}

console.log(
  '[run-cjs] Node ' +
    process.version +
    ' (' +
    modeLabel +
    '): ' +
    passCount +
    '/' +
    passCount +
    ' scenarios passed'
)
