// TS/JS top-level walk for the generic tree-sitter chunker. Pure walk logic —
// imports only the core (emit/nodeName/types), never the registry, so the registry
// can reference it without a cycle. Mirrors the ts-morph emitStatement contract
// node-for-node (validated hit@5 84%). The tsx vs typescript grammar choice lives
// in the registry's grammarFor; this walk is grammar-shape-identical for both.

import type { Node as SyntaxNode } from 'web-tree-sitter';
import {
  collectCallees,
  type EmitCtx,
  emit,
  nodeName,
} from '../tree-sitter-core.js';

export const TS_COMMENT_PREFIXES = ['//', '*', '/*'] as const;

// Name of a TS/JS call target: `foo()` → "foo"; `obj.foo()` → "foo" (method name).
function tsCalleeName(call: SyntaxNode): string | undefined {
  const fn = call.childForFieldName('function');
  if (!fn) return undefined;
  if (fn.type === 'member_expression') {
    return fn.childForFieldName('property')?.text ?? undefined;
  }
  if (fn.type === 'identifier') return fn.text;
  return undefined;
}

function tsCallees(node: SyntaxNode): string[] {
  return collectCallees(node, 'call_expression', tsCalleeName);
}

// Module specifiers of file-level imports: `import x from 'm'` / `import 'm'` → "m".
function tsFileImports(root: SyntaxNode): string[] {
  const out = new Set<string>();
  for (const node of root.namedChildren) {
    if (node.type !== 'import_statement') continue;
    const source = node.childForFieldName('source');
    const spec = source?.text.replace(/^['"`]|['"`]$/g, '');
    if (spec) out.add(spec);
  }
  return [...out];
}

function isFunctionValue(node: SyntaxNode | null): boolean {
  return (
    node !== null &&
    (node.type === 'arrow_function' || node.type === 'function_expression')
  );
}

function emitClassMembers(
  classNode: SyntaxNode,
  className: string,
  ctx: EmitCtx,
): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;
  for (const m of body.namedChildren) {
    const isMethod = m.type === 'method_definition';
    const isArrowField =
      m.type === 'public_field_definition' &&
      isFunctionValue(m.childForFieldName('value'));
    if (!isMethod && !isArrowField) continue;
    const mn = nodeName(m);
    emit(
      m,
      'method',
      mn ? `${className}.${mn}` : undefined,
      ctx,
      false,
      tsCallees(m),
    );
  }
}

/**
 * Classify one declaration and emit chunk(s).
 *   spanNode — the node whose line span becomes the chunk (export_statement when
 *              exported, so the `export`/`export default` keyword is included).
 *   declNode — the underlying declaration that determines kind/symbol/members.
 */
function classifyAndEmit(
  spanNode: SyntaxNode,
  declNode: SyntaxNode,
  ctx: EmitCtx,
): void {
  switch (declNode.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
      // function_signature (overload, no body) is a distinct node type and never
      // lands here, so each function_declaration is a real implementation.
      emit(
        spanNode,
        'function',
        nodeName(declNode),
        ctx,
        true,
        tsCallees(declNode),
      );
      return;
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'class': {
      // `class` = class expression, e.g. `export default class {}`
      const name = nodeName(declNode);
      emit(spanNode, 'class', name, ctx, true, tsCallees(declNode));
      emitClassMembers(declNode, name ?? 'default', ctx);
      return;
    }
    case 'interface_declaration':
      emit(spanNode, 'interface', nodeName(declNode), ctx, true);
      return;
    case 'type_alias_declaration':
    case 'enum_declaration':
      emit(spanNode, 'type', nodeName(declNode), ctx, true);
      return;
    case 'lexical_declaration':
    case 'variable_declaration': {
      // `export const foo = () => {}` / `const foo = function () {}` → function chunk
      const fnDecl = declNode.namedChildren.find(
        (d) =>
          d.type === 'variable_declarator' &&
          isFunctionValue(d.childForFieldName('value')),
      );
      if (fnDecl)
        emit(
          spanNode,
          'function',
          nodeName(fnDecl),
          ctx,
          true,
          tsCallees(declNode),
        );
      return;
    }
    default:
      return;
  }
}

export function typescriptWalk(root: SyntaxNode, ctx: EmitCtx): void {
  ctx.imports = tsFileImports(root);
  for (const node of root.namedChildren) {
    if (node.type === 'export_statement') {
      const inner =
        node.childForFieldName('declaration') ??
        node.namedChildren.find(
          (n) => n.type !== 'export' && n.type !== 'string',
        );
      if (inner) classifyAndEmit(node, inner, ctx); // span = export_statement, classify inner
      continue;
    }
    classifyAndEmit(node, node, ctx);
  }
}
