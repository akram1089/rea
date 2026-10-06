import * as t from "@babel/types";

import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { evaluateSemanticBinding } from "./javascriptSemanticValues.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

/** Keep explicit property mutations outside the initializer-only value lattice. */
export const collectSemanticMemberMutations = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const markValue = (node: t.Node, depth = 0): void => {
    if (t.isIdentifier(node)) {
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (binding === undefined || binding.valueMutated) return;
      const value = evaluateSemanticBinding(binding, state);
      if (value.status === "literal" || value.status === "union") return;
      binding.valueMutated = true;
      for (const initializer of binding.initializers)
        markValue(initializer.node, depth);
      return;
    }
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      markValue(node.object, depth + 1);
      return;
    }
    for (const value of referencedValues(node, depth))
      markValue(value.node, value.depth);
  };
  const markTarget = (node: t.Node): void => {
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
      markValue(node.object);
    else if (t.isRestElement(node)) markTarget(node.argument);
    else if (t.isAssignmentPattern(node)) markTarget(node.left);
    else if (t.isArrayPattern(node)) {
      for (const element of node.elements)
        if (element !== null) markTarget(element);
    } else if (t.isObjectPattern(node)) {
      for (const property of node.properties)
        markTarget(
          t.isRestElement(property) ? property.argument : property.value,
        );
    }
  };
  traverseJavaScriptAst(program, {
    enter: (node) => {
      if (t.isAssignmentExpression(node)) markTarget(node.left);
      else if (t.isUpdateExpression(node)) markTarget(node.argument);
      else if (t.isUnaryExpression(node, { operator: "delete" }))
        markTarget(node.argument);
      else if (t.isForOfStatement(node) || t.isForInStatement(node))
        markTarget(node.left);
    },
  });
};

interface ReferencedValue {
  readonly node: t.Node;
  readonly depth: number;
}

const referencedValues = (
  node: t.Node,
  depth: number,
): readonly ReferencedValue[] => {
  if (t.isObjectExpression(node))
    return depth === 0
      ? []
      : node.properties.flatMap((property) =>
          t.isObjectProperty(property)
            ? [{ node: property.value, depth: depth - 1 }]
            : t.isSpreadElement(property)
              ? [{ node: property.argument, depth }]
              : [],
        );
  if (t.isArrayExpression(node))
    return depth === 0
      ? []
      : node.elements.flatMap((element) =>
          element === null
            ? []
            : [
                {
                  node: t.isSpreadElement(element) ? element.argument : element,
                  depth: t.isSpreadElement(element) ? depth : depth - 1,
                },
              ],
        );
  if (
    t.isTSAsExpression(node) ||
    t.isTSTypeAssertion(node) ||
    t.isTSNonNullExpression(node)
  )
    return [{ node: node.expression, depth }];
  if (t.isConditionalExpression(node))
    return [
      { node: node.consequent, depth },
      { node: node.alternate, depth },
    ];
  if (t.isLogicalExpression(node))
    return [
      { node: node.left, depth },
      { node: node.right, depth },
    ];
  return [];
};
