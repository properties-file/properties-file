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
 *
 * `distRoot` defaults to `<repo>/dist/cjs` (resolved relative to this file) and
 * can be overridden to an absolute path, which the Node.js 0.4.0 Docker
 * container uses to point at `/dist/cjs`.
 */

var fs = require('fs')
var path = require('path')

// ---------------------------------------------------------------------------
// Locate golden.json and the dist/cjs root
// ---------------------------------------------------------------------------

var distRoot = process.argv[2] || path.join(__dirname, '..', '..', 'dist', 'cjs')
var goldenPath = path.join(__dirname, 'golden.json')

var scenarios = JSON.parse(fs.readFileSync(goldenPath, 'utf8'))

var getProperties = require(path.join(distRoot, 'index.js')).getProperties
var Properties = require(path.join(distRoot, 'parser', 'index.js')).Properties
var PropertiesEditor = require(path.join(distRoot, 'editor', 'index.js')).PropertiesEditor
var escapeModule = require(path.join(distRoot, 'escape', 'index.js'))
var unescapeContent = require(path.join(distRoot, 'unescape', 'index.js')).unescapeContent

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
      ': ' +
      passCount +
      '/' +
      (passCount + failCount) +
      ' scenarios passed — FAILED'
  )
  process.exit(1)
}

console.log(
  '[run-cjs] Node ' + process.version + ': ' + passCount + '/' + passCount + ' scenarios passed'
)
