// Go top-level walk for the generic tree-sitter chunker. Pure walk logic —
// imports only the core, never the registry (no cycle). Maps:
//   function_declaration → function (name)
//   method_declaration   → method   (Receiver.method, pointer/value receiver)
//   type_declaration     → type | interface (per the underlying type)

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { type EmitCtx, emit, nodeName } from '../tree-sitter-core.js';

export const GO_COMMENT_PREFIXES = ['//', '*', '/*'] as const;

// `func (a *Animal) M()` → receiver type "Animal" (strip the binding name + pointer).
function receiverType(method: SyntaxNode): string | undefined {
  const receiver = method.childForFieldName('receiver'); // parameter_list
  const param = receiver?.namedChildren.find(
    (c) => c.type === 'parameter_declaration',
  );
  const typeText = param?.childForFieldName('type')?.text;
  return typeText
    ? typeText.replace(/^[*&]/, '').trim() || undefined
    : undefined;
}

export function goWalk(root: SyntaxNode, ctx: EmitCtx): void {
  for (const node of root.namedChildren) {
    if (node.type === 'function_declaration') {
      emit(node, 'function', nodeName(node), ctx, true);
    } else if (node.type === 'method_declaration') {
      const name = nodeName(node);
      const recv = receiverType(node);
      const symbol = name ? (recv ? `${recv}.${name}` : name) : undefined;
      emit(node, 'method', symbol, ctx, true);
    } else if (node.type === 'type_declaration') {
      // `type Name struct{…}` / `interface{…}`; a `type ( … )` block holds several.
      const specs = node.namedChildren.filter((c) => c.type === 'type_spec');
      const single = specs.length === 1;
      for (const spec of specs) {
        const underlying = spec.childForFieldName('type')?.type;
        const kind = underlying === 'interface_type' ? 'interface' : 'type';
        // Span the whole declaration when it holds one spec (keeps the `type` keyword
        // + leading doc comment); otherwise span each spec individually.
        emit(single ? node : spec, kind, nodeName(spec), ctx, true);
      }
    }
  }
}
