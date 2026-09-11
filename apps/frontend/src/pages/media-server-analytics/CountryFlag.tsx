import 'flag-icons/css/flag-icons.min.css';

/**
 * A country's flag as a bundled SVG, from an ISO-3166 alpha-2 code.
 *
 * We render `flag-icons` (a CSS background sprite of SVGs shipped with the app),
 * not a regional-indicator emoji: emoji flags are absent on Windows, where the
 * browser falls back to showing the two-letter code — so the emoji approach
 * showed "US" instead of a flag for a large share of operators. The SVGs are
 * bundled and lazy-loaded (only the flags actually shown are fetched), so this
 * stays offline and adds no runtime dependency.
 *
 * The flag is decorative: every place it appears sits beside the country/city
 * name in text, so it is hidden from assistive tech and carries only a hover
 * title. An unrecognised code renders nothing rather than a broken box.
 */
export function CountryFlag({
  code,
  className = '',
}: {
  code?: string | null;
  className?: string;
}) {
  const cc = (code ?? '').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) return null;
  return (
    <span
      className={`fi fi-${cc} shrink-0 rounded-[2px] ${className}`.trim()}
      title={cc.toUpperCase()}
      aria-hidden
    />
  );
}
