/**
 * Query cost limiting.
 *
 * A GraphQL endpoint with no cost limit is an availability problem: a single
 * deeply nested query over a portfolio's charges, each with its allocations and
 * their transactions, can cost more than any legitimate request.
 *
 * Two independent limits apply, because they catch different shapes:
 *
 *  - **Depth** catches recursive nesting such as
 *    `charge -> allocations -> transaction -> allocations -> ...`, which is
 *    cheap to write and expensive to serve.
 *  - **Complexity** catches breadth: a shallow query asking for 100 properties
 *    with 100 units each is not deep at all.
 *
 * Both are evaluated before execution starts, so a rejected query costs one
 * parse rather than a database round trip.
 */

import { GraphQLError, type DocumentNode, type GraphQLSchema } from 'graphql';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';
import type { ApolloServerPlugin } from '@apollo/server';
import type { Logger } from '@rentwell/observability';

export interface ComplexityOptions {
  readonly maxComplexity: number;
  readonly maxDepth: number;
  readonly logger: Logger;
}

/** Cost assigned to a field with no explicit estimate. */
const DEFAULT_FIELD_COST = 1;

export function complexityPlugin(options: ComplexityOptions): ApolloServerPlugin {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ request, document, schema, operationName }) {
          const depth = maxSelectionDepth(document);
          if (depth > options.maxDepth) {
            throw new GraphQLError(
              `Query is nested ${depth} levels deep; the limit is ${options.maxDepth}.`,
              { extensions: { code: 'VALIDATION_FAILED', depth, maxDepth: options.maxDepth } },
            );
          }

          const complexity = getComplexity({
            schema: schema as GraphQLSchema,
            query: document,
            variables: request.variables,
            estimators: [
              // A field may declare its own cost through an extension; anything
              // that does not gets the flat default.
              fieldExtensionsEstimator(),
              simpleEstimator({ defaultComplexity: DEFAULT_FIELD_COST }),
            ],
          });

          if (complexity > options.maxComplexity) {
            options.logger.warn(
              { operationName, complexity, maxComplexity: options.maxComplexity },
              'Rejected a query that exceeded the complexity limit',
            );
            throw new GraphQLError(
              `Query complexity ${complexity} exceeds the limit of ${options.maxComplexity}. Request fewer fields or a smaller page.`,
              {
                extensions: {
                  code: 'VALIDATION_FAILED',
                  complexity,
                  maxComplexity: options.maxComplexity,
                },
              },
            );
          }
        },
      };
    },
  };
}

/**
 * Deepest selection nesting in a document.
 *
 * Fragment spreads are followed, because otherwise a recursive fragment would
 * hide arbitrary depth behind a single spread.
 */
export function maxSelectionDepth(document: DocumentNode): number {
  const fragments = new Map<string, { selectionSet?: { selections: readonly unknown[] } }>();

  for (const definition of document.definitions) {
    if (definition.kind === 'FragmentDefinition') {
      fragments.set(definition.name.value, definition as never);
    }
  }

  const visit = (node: unknown, depth: number, seen: ReadonlySet<string>): number => {
    const selectionSet = (node as { selectionSet?: { selections: readonly unknown[] } })
      .selectionSet;
    if (!selectionSet) return depth;

    let deepest = depth;
    for (const selection of selectionSet.selections) {
      const kind = (selection as { kind: string }).kind;

      if (kind === 'FragmentSpread') {
        const name = (selection as { name: { value: string } }).name.value;
        // A fragment cycle is a parse-time error in valid documents, but
        // guarding here keeps a malformed one from looping forever.
        if (seen.has(name)) continue;
        const fragment = fragments.get(name);
        if (fragment) {
          deepest = Math.max(deepest, visit(fragment, depth, new Set([...seen, name])));
        }
        continue;
      }

      if (kind === 'InlineFragment') {
        deepest = Math.max(deepest, visit(selection, depth, seen));
        continue;
      }

      deepest = Math.max(deepest, visit(selection, depth + 1, seen));
    }

    return deepest;
  };

  let deepest = 0;
  for (const definition of document.definitions) {
    if (definition.kind !== 'OperationDefinition') continue;
    deepest = Math.max(deepest, visit(definition, 0, new Set()));
  }
  return deepest;
}
