// Swift top-level walk for the generic tree-sitter chunker. Pure walk logic —
// imports only the core, never the registry (no cycle). Grammar:
// alex-pinkus/tree-sitter-swift (vendored wasm — see grammars/NOTICE.md). Maps:
//   class_declaration → class | type | block, by its leading keyword:
//     `class` / `actor` → class  (members → Type.method)
//     `struct`          → type   (members → Struct.method)
//     `enum`            → type   (members → Enum.method)
//     `extension`       → block  (symbol = extended type; members → Type.method)
//   protocol_declaration → interface (its protocol_function_declaration members)
//   function_declaration → function (name)
// The grammar reuses `class_declaration` for struct/class/enum/actor/extension, so
// the kind is recovered from the keyword child token. Members (incl. init/deinit)
// use Swift's `.` separator: Type.method, Type.init, Type.deinit.

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { type EmitCtx, emit, nodeName } from '../tree-sitter-core.js';
import type { ChunkKind } from '../types.js';

export const SWIFT_COMMENT_PREFIXES = ['//', '*', '/*', '///'] as const;

// class_declaration covers struct / class / enum / actor / extension; the kind is
// the leading keyword token (an unnamed child).
function classDeclKind(node: SyntaxNode): ChunkKind {
  const kw = node.children.find(
    (c) => c.type === 'struct' || c.type === 'class' || c.type === 'enum'
      || c.type === 'actor' || c.type === 'extension',
  );
  switch (kw?.type) {
    case 'class':
    case 'actor':     return 'class'; // reference types
    case 'extension': return 'block';
    default:          return 'type';  // struct, enum (and any future value-type keyword)
  }
}

function classBody(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName('body')
    ?? node.namedChildren.find((c) => c.type === 'class_body' || c.type === 'protocol_body')
    ?? null;
}

// Member node types emitted as methods. init/deinit are distinct node types in the
// grammar (not function_declaration), so they need explicit inclusion — otherwise
// initializers (a type's key entry points) would be swallowed into the type chunk.
const METHOD_MEMBER_TYPES = new Set([
  'function_declaration',
  'protocol_function_declaration',
  'init_declaration',
  'deinit_declaration',
]);

// deinit has no name field; init's name field is the `init` keyword itself.
function memberName(m: SyntaxNode): string | undefined {
  if (m.type === 'deinit_declaration') return 'deinit';
  return nodeName(m);
}

// Emit the method members of a type/protocol body as Type.method.
function emitMembers(body: SyntaxNode, typeName: string | undefined, ctx: EmitCtx): void {
  for (const m of body.namedChildren) {
    if (!METHOD_MEMBER_TYPES.has(m.type)) continue;
    const mn = memberName(m);
    const symbol = mn ? (typeName ? `${typeName}.${mn}` : mn) : undefined;
    emit(m, 'method', symbol, ctx, false);
  }
}

export function swiftWalk(root: SyntaxNode, ctx: EmitCtx): void {
  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'class_declaration': {
        const name = nodeName(node);
        emit(node, classDeclKind(node), name, ctx, true);
        const body = classBody(node);
        if (body) emitMembers(body, name, ctx);
        break;
      }
      case 'protocol_declaration': {
        const name = nodeName(node);
        emit(node, 'interface', name, ctx, true);
        const body = classBody(node);
        if (body) emitMembers(body, name, ctx);
        break;
      }
      case 'function_declaration':
        emit(node, 'function', nodeName(node), ctx, true);
        break;
      default:
        break;
    }
  }
}
