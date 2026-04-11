import { formatNormalized as formatNormalizedImpl } from './normalize'
import { parseDocument } from './parse'

import type {
  BlankLineNode,
  CommentNode,
  KeyCollisions,
  KeyValuePairObject,
  NormalizeOptions,
  PropertiesNode,
  PropertyNode,
} from './nodes'

const BOM = '\uFEFF'

/**
 * A lossless, ordered representation of a `.properties` file.
 *
 * Every element in the file — properties, comments, and blank lines — is
 * preserved in order. Duplicate keys are all retained. The original content
 * can be reconstructed exactly via {@link format}.
 */
export class Properties {
  /** Whether the content started with a BOM character. */
  readonly hasBom: boolean
  /** The end-of-line character detected from the content. */
  readonly eolCharacter: string
  /** All nodes in file order. */
  readonly nodes: PropertiesNode[]

  /**
   * Parse a `.properties` file into a lossless node structure.
   *
   * @param content - The content of a `.properties` file (string or Buffer).
   */
  constructor(content: string | Buffer) {
    const result = parseDocument(content)
    this.hasBom = result.hasBom
    this.eolCharacter = result.eolCharacter
    this.nodes = result.nodes
  }

  // ─── Query methods ──────────────────────────────────────────────────

  /**
   * Get all property nodes in file order (including duplicates).
   *
   * @returns An array of all {@link PropertyNode} instances.
   */
  getProperties(): PropertyNode[] {
    return this.nodes.filter((node): node is PropertyNode => node.type === 'property')
  }

  /**
   * Get all comment nodes in file order.
   *
   * @returns An array of all {@link CommentNode} instances.
   */
  getComments(): CommentNode[] {
    return this.nodes.filter((node): node is CommentNode => node.type === 'comment')
  }

  /**
   * Get all blank line nodes in file order.
   *
   * @returns An array of all {@link BlankLineNode} instances.
   */
  getBlankLines(): BlankLineNode[] {
    return this.nodes.filter((node): node is BlankLineNode => node.type === 'blank')
  }

  /**
   * Get the effective key-value map (last-wins semantics for duplicate keys).
   *
   * @returns A plain object where each key maps to its last-occurring value.
   */
  toObject(): KeyValuePairObject {
    const result: KeyValuePairObject = {}
    for (const node of this.nodes) {
      if (node.type === 'property') {
        result[node.key] = node.value
      }
    }
    return result
  }

  /**
   * Get all property nodes for a given key (all occurrences, in file order).
   *
   * @param key - The unescaped key to search for.
   *
   * @returns An array of matching {@link PropertyNode} instances (empty if not found).
   */
  getPropertyNodes(key: string): PropertyNode[] {
    return this.nodes.filter(
      (node): node is PropertyNode => node.type === 'property' && node.key === key
    )
  }

  /**
   * Get the effective property node for a given key (last occurrence).
   *
   * @param key - The unescaped key to search for.
   *
   * @returns The last {@link PropertyNode} with this key, or `undefined`.
   */
  getEffectiveProperty(key: string): PropertyNode | undefined {
    for (let index = this.nodes.length - 1; index >= 0; index--) {
      const node = this.nodes[index]
      if (node.type === 'property' && node.key === key) {
        return node
      }
    }
    return undefined
  }

  /**
   * Get keys that appear more than once, with all their property nodes.
   *
   * @returns An array of {@link KeyCollisions} for duplicate keys.
   */
  getKeyCollisions(): KeyCollisions[] {
    const nodesByKey: { [key: string]: PropertyNode[] } = {}
    for (const node of this.nodes) {
      if (node.type === 'property') {
        if (!nodesByKey[node.key]) {
          nodesByKey[node.key] = []
        }
        nodesByKey[node.key].push(node)
      }
    }

    const collisions: KeyCollisions[] = []
    for (const key of Object.keys(nodesByKey)) {
      if (nodesByKey[key].length > 1) {
        collisions.push({ key, nodes: nodesByKey[key] })
      }
    }
    return collisions
  }

  /**
   * Get comment and blank line nodes immediately preceding a property.
   *
   * Walks backward from the last occurrence of the given key, collecting
   * comment and blank line nodes until reaching another property or the
   * start of the file.
   *
   * @param key - The unescaped key to find leading nodes for.
   *
   * @returns An array of preceding {@link CommentNode} and {@link BlankLineNode} instances.
   */
  getLeadingNodes(key: string): (CommentNode | BlankLineNode)[] {
    // Find the last property node with this key.
    let propertyIndex = -1
    for (let index = this.nodes.length - 1; index >= 0; index--) {
      const node = this.nodes[index]
      if (node.type === 'property' && node.key === key) {
        propertyIndex = index
        break
      }
    }

    if (propertyIndex <= 0) {
      return []
    }

    // Walk backward collecting comment/blank nodes until we hit a property.
    const leading: (CommentNode | BlankLineNode)[] = []
    for (let index = propertyIndex - 1; index >= 0; index--) {
      const node = this.nodes[index]
      if (node.type === 'property') {
        break
      }
      leading.unshift(node)
    }

    return leading
  }

  // ─── Reconstruction ─────────────────────────────────────────────────

  /**
   * Format the `.properties` content as a string.
   *
   * Without options, produces an exact lossless reconstruction of the original
   * content. With options, produces normalized output — standardize separators,
   * remove comments, deduplicate keys, and more.
   *
   * @param options - Optional normalization options. When omitted, the output
   *   is a lossless round-trip of the original content.
   *
   * @returns The formatted `.properties` file content.
   */
  format(options?: NormalizeOptions): string {
    if (!options) {
      const eol = this.eolCharacter
      const parts: string[] = []

      for (const node of this.nodes) {
        if (node.type === 'property') {
          parts.push(node.rawLines.join(eol))
        } else {
          parts.push(node.rawLine)
        }
      }

      return (this.hasBom ? BOM : '') + parts.join(eol)
    }

    return formatNormalizedImpl(this.nodes, this.hasBom, this.eolCharacter, options)
  }
}
