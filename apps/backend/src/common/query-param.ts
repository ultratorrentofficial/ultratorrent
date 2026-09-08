/**
 * Reading a query parameter as the type the handler says it is.
 *
 * A signature of `@Query('t') token?: string` is a compile-time claim, not a
 * runtime guarantee. Express parses `?t=a&t=b` into an ARRAY and `?t[x]=1` into
 * an OBJECT, and both arrive at a parameter TypeScript has been told is a
 * string. Nothing throws — the value simply behaves differently further down.
 *
 * That is how these bugs stay hidden. `['a','.']` has `lastIndexOf` and `slice`
 * like a string does, so a parser written against strings keeps running and
 * produces nonsense instead of an error; `Buffer.from(['a'])` coerces each
 * element through `Number` and yields zero bytes rather than rejecting. Code can
 * fail closed by coincidence of coercion, which is not the same as being safe,
 * and stops being true the moment the parser is refactored.
 *
 * So the shape is checked once, at the boundary, before the value reaches
 * anything that reasons about it.
 */

/**
 * The parameter if it really is a string, otherwise `undefined`.
 *
 * An array or object is treated as absent rather than as an error: these are
 * public endpoints reached from mail clients and link scanners, and a malformed
 * parameter should render the ordinary "not a valid link" page rather than a
 * stack trace or a 400 that looks like an outage.
 *
 * Only the first argument's TYPE is judged — an empty string is a legitimate
 * value to pass on, and callers decide what it means.
 */
export function singleQueryParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
