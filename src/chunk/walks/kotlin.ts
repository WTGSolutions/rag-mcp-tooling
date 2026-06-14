// Kotlin top-level walk for the generic tree-sitter chunker. Pure walk logic —
// imports only the core, never the registry (no cycle). Maps:
//   class_declaration  → class | interface | type (enum), members → Class.method
//   object_declaration → class (named singleton), members → Object.method
//   function_declaration → function (name)
// The grammar reuses `class_declaration` for `class`, `interface`, `data class`
// and `enum class`; the kind is recovered from the leading keyword token
// (`interface`) and the `enum` modifier. Members use the Kotlin `.` separator.

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { type EmitCtx, emit, nodeName } from '../tree-sitter-core.js';
import type { ChunkKind } from '../types.js';

export const KOTLIN_COMMENT_PREFIXES = ['//', '*', '/*'] as const;

function classBody(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName('body')
    ?? node.namedChildren.find((c) => c.type === 'class_body')
    ?? null;
}

// class_declaration covers class / interface / enum class / data class. The
// `interface` keyword is an unnamed child token; `enum` is a class_modifier.
function classDeclKind(node: SyntaxNode): ChunkKind {
  if (node.children.some((c) => c.type === 'interface')) return 'interface';
  const mods = node.namedChildren.find((c) => c.type === 'modifiers');
  if (mods && /\benum\b/.test(mods.text)) return 'type';
  return 'class';
}

// Emit the function members of a class/object body as Type.method.
function emitMembers(body: SyntaxNode, typeName: string | undefined, ctx: EmitCtx): void {
  for (const m of body.namedChildren) {
    if (m.type !== 'function_declaration') continue;
    const mn = nodeName(m);
    const symbol = mn ? (typeName ? `${typeName}.${mn}` : mn) : undefined;
    emit(m, 'method', symbol, ctx, false);
  }
}

export function kotlinWalk(root: SyntaxNode, ctx: EmitCtx): void {
  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'class_declaration': {
        const name = nodeName(node);
        emit(node, classDeclKind(node), name, ctx, true);
        const body = classBody(node);
        if (body) emitMembers(body, name, ctx);
        break;
      }
      case 'object_declaration': {
        const name = nodeName(node);
        emit(node, 'class', name, ctx, true);
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
