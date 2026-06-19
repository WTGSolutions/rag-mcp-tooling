// C/C++ top-level walk for the generic tree-sitter chunker. Pure walk logic —
// imports only the core, never the registry (no cycle). Maps:
//   function_definition  → function  (name from declarator; out-of-line
//                          `Class::method` is kept verbatim from qualified_identifier)
//   class_specifier      → class, with inline members → Class::method
//   struct_specifier /
//   union_specifier      → type,  with inline members → Type::method
//   enum_specifier       → type
//   namespace_definition /
//   linkage_specification → recursed into (members emitted individually); the
//                          container itself is never one blob chunk — that would
//                          hide every symbol declared inside it. `extern "C" { … }`
//                          (a linkage_specification) is the common case in C headers.
//   template_declaration → unwrapped: the inner definition is chunked over the
//                          full template span so `template<…>` rides along
// Unlike Go/Java, a C++ function name is nested inside its declarator (there is no
// `name` field), so funcDeclName descends pointer/reference declarators to reach it.

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { type EmitCtx, emit, nodeName } from '../tree-sitter-core.js';

export const CPP_COMMENT_PREFIXES = ['//', '*', '/*'] as const;

// Descend through pointer/reference/array declarator wrappers to the
// function_declarator, then read its declarator (identifier / field_identifier /
// qualified_identifier / destructor_name / operator_name). Returns the name text,
// or undefined for an unnameable declarator.
function funcDeclName(fnDef: SyntaxNode): string | undefined {
  let d: SyntaxNode | null = fnDef.childForFieldName('declarator');
  while (d && d.type !== 'function_declarator') {
    d = d.childForFieldName('declarator');
  }
  return d?.childForFieldName('declarator')?.text ?? undefined;
}

function classBody(node: SyntaxNode): SyntaxNode | null {
  return (
    node.childForFieldName('body') ??
    node.namedChildren.find((c) => c.type === 'field_declaration_list') ??
    null
  );
}

// Emit inline method definitions inside a class/struct body as Class::method.
// Member declarations without a body (prototypes) are left for the gap chunks.
function emitMembers(
  node: SyntaxNode,
  typeName: string | undefined,
  ctx: EmitCtx,
): void {
  const body = classBody(node);
  if (!body) return;
  for (const m of body.namedChildren) {
    const fn =
      m.type === 'template_declaration'
        ? m.namedChildren.find((c) => c.type === 'function_definition')
        : m.type === 'function_definition'
          ? m
          : undefined;
    if (!fn) continue;
    const raw = funcDeclName(fn);
    const symbol = raw ? (typeName ? `${typeName}::${raw}` : raw) : undefined;
    // span = the wrapping template_declaration when present (keeps `template<…>`).
    emit(m, 'method', symbol, ctx, false);
  }
}

// The definition carried by a template_declaration, if any.
function templateInner(node: SyntaxNode): SyntaxNode | undefined {
  return node.namedChildren.find(
    (c) =>
      c.type === 'function_definition' ||
      c.type === 'class_specifier' ||
      c.type === 'struct_specifier' ||
      c.type === 'union_specifier' ||
      c.type === 'enum_specifier',
  );
}

// Emit a single top-level definition. `spanNode` defines the line range (the
// template_declaration when present); `defNode` is the classified definition.
function emitDefinition(
  spanNode: SyntaxNode,
  defNode: SyntaxNode,
  ctx: EmitCtx,
): void {
  switch (defNode.type) {
    case 'function_definition':
      emit(spanNode, 'function', funcDeclName(defNode), ctx, true);
      break;
    case 'class_specifier': {
      const name = nodeName(defNode);
      emit(spanNode, 'class', name, ctx, true);
      emitMembers(defNode, name, ctx);
      break;
    }
    case 'struct_specifier':
    case 'union_specifier': {
      const name = nodeName(defNode);
      emit(spanNode, 'type', name, ctx, true);
      emitMembers(defNode, name, ctx); // C++ structs/unions can carry methods
      break;
    }
    case 'enum_specifier':
      emit(spanNode, 'type', nodeName(defNode), ctx, true);
      break;
    default:
      break;
  }
}

// Transparent containers: their members are chunked individually, the container
// itself is never one blob chunk. namespace_definition wraps a `declaration_list`;
// linkage_specification is `extern "C" { … }`, ubiquitous in C/C++ headers.
const TRANSPARENT_CONTAINERS = new Set([
  'namespace_definition',
  'linkage_specification',
]);

function walkNodes(nodes: readonly SyntaxNode[], ctx: EmitCtx): void {
  for (const node of nodes) {
    if (TRANSPARENT_CONTAINERS.has(node.type)) {
      const body =
        node.childForFieldName('body') ??
        node.namedChildren.find((c) => c.type === 'declaration_list');
      if (body) walkNodes(body.namedChildren, ctx);
    } else if (node.type === 'template_declaration') {
      const inner = templateInner(node);
      if (inner) emitDefinition(node, inner, ctx);
    } else {
      emitDefinition(node, node, ctx);
    }
  }
}

export function cppWalk(root: SyntaxNode, ctx: EmitCtx): void {
  walkNodes(root.namedChildren, ctx);
}
