// Python top-level walk for the generic tree-sitter chunker. Pure walk logic —
// imports only the core + its own node-type data, never the registry, so the
// registry can reference it without a cycle. Functions and classes are top-level
// chunks; a function_definition inside a class body becomes a `Class.method`.

import type { Node as SyntaxNode } from 'web-tree-sitter';
import {
  collectCallees,
  type EmitCtx,
  emit,
  nodeName,
} from '../tree-sitter-core.js';

export const PYTHON_COMMENT_PREFIXES = ['#'] as const;

// Name of a Python call target: `foo()` → "foo"; `obj.foo()` → "foo" (method name).
function pyCalleeName(call: SyntaxNode): string | undefined {
  const fn = call.childForFieldName('function');
  if (!fn) return undefined;
  if (fn.type === 'attribute') {
    return fn.childForFieldName('attribute')?.text ?? undefined;
  }
  if (fn.type === 'identifier') return fn.text;
  return undefined;
}

function pyCallees(node: SyntaxNode): string[] {
  return collectCallees(node, 'call', pyCalleeName);
}

// Module names of file-level imports: `import a.b` → "a.b"; `from x import y` → "x".
function pyFileImports(root: SyntaxNode): string[] {
  const out = new Set<string>();
  for (const node of root.namedChildren) {
    if (node.type === 'import_statement') {
      for (const child of node.namedChildren) {
        const name =
          child.type === 'aliased_import'
            ? child.childForFieldName('name')?.text
            : child.text;
        if (name) out.add(name);
      }
    } else if (node.type === 'import_from_statement') {
      const mod = node.childForFieldName('module_name')?.text;
      if (mod) out.add(mod);
    }
  }
  return [...out];
}

function walkClassBody(
  classNode: SyntaxNode,
  className: string,
  ctx: EmitCtx,
): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;

  for (const child of body.namedChildren) {
    if (child.type === 'function_definition') {
      const methodName = nodeName(child);
      emit(
        child,
        'method',
        methodName ? `${className}.${methodName}` : undefined,
        ctx,
        false,
        pyCallees(child),
      );
    } else if (child.type === 'decorated_definition') {
      const inner = child.namedChildren.find(
        (n) => n.type === 'function_definition',
      );
      if (inner) {
        const methodName = nodeName(inner);
        emit(
          child,
          'method',
          methodName ? `${className}.${methodName}` : undefined,
          ctx,
          false,
          pyCallees(inner),
        );
      }
    }
  }
}

export function pythonWalk(root: SyntaxNode, ctx: EmitCtx): void {
  ctx.imports = pyFileImports(root);
  for (const node of root.namedChildren) {
    // Only def/class (and their decorated form) are symbols; any other top-level
    // node is module code captured by gap chunks in the core.
    if (node.type === 'decorated_definition') {
      const inner = node.namedChildren.find(
        (n) =>
          n.type === 'function_definition' || n.type === 'class_definition',
      );
      if (!inner) continue;
      const name = nodeName(inner);
      const isClass = inner.type === 'class_definition';
      emit(
        node,
        isClass ? 'class' : 'function',
        name,
        ctx,
        true,
        pyCallees(inner),
      );
      if (isClass && name) walkClassBody(inner, name, ctx);
    } else if (node.type === 'class_definition') {
      const name = nodeName(node);
      emit(node, 'class', name, ctx, true, pyCallees(node));
      if (name) walkClassBody(node, name, ctx);
    } else if (node.type === 'function_definition') {
      emit(node, 'function', nodeName(node), ctx, true, pyCallees(node));
    }
  }
}
