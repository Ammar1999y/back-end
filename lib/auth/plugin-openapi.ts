/**
 * `lib/http/openapi.ts` refuses to build when a served path declares no 200, and
 * a local plugin endpoint has no generated schema unless it says so.
 */
type JsonSchema = Record<string, unknown>;

export function envelopeResponse(
  description: string,
  data: JsonSchema | null = null
) {
  // Return type inferred, not annotated: Better Call's `metadata.openapi` is a
  // precise structural type that `Record<string, unknown>` is too wide for.
  return {
    responses: {
      '200': {
        description,
        content: {
          'application/json': {
            schema: {
              // `as const`: the library types this against its own
              // `OpenAPISchemaType` union, which a widened `string` fails.
              type: 'object' as const,
              properties: {
                success: { type: 'boolean' },
                message: { type: 'string' },
                data: data ?? { type: 'object' },
              },
              required: ['success'],
            },
          },
        },
      },
    },
  };
}
