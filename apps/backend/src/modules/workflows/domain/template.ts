import { resolvePath } from './condition-eval';

/**
 * Render `{{path}}` templates inside string values against a context object. The ONLY form
 * of value interpolation workflows support — a fixed substitution over resolved field paths,
 * never eval/Function/template-literal execution (non-negotiable). Shared by the simulator
 * and the durable executor so a dry run renders identically to a real run.
 */
export function renderValue(value: unknown, ctx: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const resolved = resolvePath(ctx, path);
    return resolved == null ? '' : String(resolved);
  });
}

export function renderConfig(config: Record<string, unknown>, ctx: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) out[k] = renderValue(v, ctx);
  return out;
}
