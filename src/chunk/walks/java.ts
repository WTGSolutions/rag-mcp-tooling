// Java top-level walk for the generic tree-sitter chunker. Pure walk logic —
// imports only the core, never the registry (no cycle). Maps:
//   class_declaration / record_declaration → class, with members → Class.method
//   interface_declaration                  → interface
//   enum_declaration                       → type
// Annotations/Javadoc sit inside the declaration node span, so they ride along.

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { type EmitCtx, emit, nodeName } from '../tree-sitter-core.js';

export const JAVA_COMMENT_PREFIXES = ['//', '*', '/*'] as const;

function emitClassMembers(
  node: SyntaxNode,
  className: string,
  ctx: EmitCtx,
): void {
  const body = node.childForFieldName('body');
  if (!body) return;
  for (const m of body.namedChildren) {
    if (m.type === 'method_declaration') {
      const mn = nodeName(m);
      emit(m, 'method', mn ? `${className}.${mn}` : undefined, ctx, false);
    } else if (m.type === 'constructor_declaration') {
      emit(m, 'method', `${className}.constructor`, ctx, false);
    }
  }
}

export function javaWalk(root: SyntaxNode, ctx: EmitCtx): void {
  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'class_declaration':
      case 'record_declaration': {
        const name = nodeName(node);
        emit(node, 'class', name, ctx, true);
        emitClassMembers(node, name ?? 'default', ctx);
        break;
      }
      case 'interface_declaration':
        emit(node, 'interface', nodeName(node), ctx, true);
        break;
      case 'enum_declaration':
        emit(node, 'type', nodeName(node), ctx, true);
        break;
      default:
        break;
    }
  }
}
