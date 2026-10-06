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
  const markValue = (node: t.Node): void => {
    if (t.isIdentifier(node)) {
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (binding === undefined || binding.valueMutated) return;
      const value = evaluateSemanticBinding(binding, state);
      if (value.status === "literal" || value.status === "union") return;
      binding.valueMutated = true;
      for (const initializer of binding.initializers)
        markValue(initializer.node);
      return;
    }
    for (const value of referencedValues(node)) markValue(value);
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

const referencedValues = (node: t.Node): readonly t.Node[] => {
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
    return [node.object];
  if (t.isObjectExpression(node))
    return node.properties.flatMap((property) =>
      t.isObjectProperty(property)
        ? [property.value]
        : t.isSpreadElement(property)
          ? [property.argument]
          : [],
    );
  if (t.isArrayExpression(node))
    return node.elements.flatMap((element) =>
      element === null
        ? []
        : [t.isSpreadElement(element) ? element.argument : element],
    );
  if (
    t.isTSAsExpression(node) ||
    t.isTSTypeAssertion(node) ||
    t.isTSNonNullExpression(node)
  )
    return [node.expression];
  if (t.isConditionalExpression(node)) return [node.consequent, node.alternate];
  if (t.isLogicalExpression(node)) return [node.left, node.right];
  return [];
};
