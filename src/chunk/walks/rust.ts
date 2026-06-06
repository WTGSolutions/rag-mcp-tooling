// Rust top-level walk for the generic tree-sitter chunker. Pure walk logic —
// imports only the core, never the registry (no cycle). Maps:
//   function_item                  → function (name)
//   struct_item / enum_item / union → type     (name)
//   trait_item                     → interface (name)
//   impl_item                      → its function_item members become Type.method

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { type EmitCtx, emit, nodeName } from '../tree-sitter-core.js';

export const RUST_COMMENT_PREFIXES = ['//', '*', '/*'] as const;

// `impl Foo<T>` / `impl Trait for Foo` → "Foo" (strip generics; methods belong to the type).
function implTypeName(impl: SyntaxNode): string | undefined {
  const typeText = impl.childForFieldName('type')?.text;
  return typeText ? typeText.split('<')[0]!.trim() || undefined : undefined;
}

export function rustWalk(root: SyntaxNode, ctx: EmitCtx): void {
  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'function_item':
        emit(node, 'function', nodeName(node), ctx, true);
        break;
      case 'struct_item':
      case 'enum_item':
      case 'union_item':
        emit(node, 'type', nodeName(node), ctx, true);
        break;
      case 'trait_item':
        emit(node, 'interface', nodeName(node), ctx, true);
        break;
      case 'impl_item': {
        const typeName = implTypeName(node);
        const body = node.childForFieldName('body');
        if (!body) break;
        for (const m of body.namedChildren) {
          if (m.type !== 'function_item') continue;
          const mn = nodeName(m);
          const symbol = mn ? (typeName ? `${typeName}.${mn}` : mn) : undefined;
          emit(m, 'method', symbol, ctx, true);
        }
        break;
      }
      default:
        break;
    }
  }
}
