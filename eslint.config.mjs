import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Flat config for the whole monorepo.
 *
 * # Why this file did not exist
 *
 * The `lint` scripts in `apps/backend` and `apps/frontend` call `eslint`, and
 * nothing installed it — it was never a dependency in any workspace. CI ran
 * `npm run lint --workspaces --if-present`, resolved some hoisted transitive
 * copy, and failed on a missing configuration. Every run for as long as the
 * history shows. The gate was not broken; it had never worked.
 *
 * # What it enforces
 *
 * The recommended sets, and no house style. Formatting rules are deliberately
 * absent: a lint gate whose failures are mostly about spacing teaches people to
 * ignore it, and this one has to earn attention it has never had.
 *
 * Type-aware rules are also absent for now. They need a `project` reference and
 * a much slower run, and turning them on the same day the gate starts working
 * would mean a large number of findings arriving with no way to tell the real
 * ones from the noise. `tsc` already runs separately with `strict`.
 */
export default tseslint.config(
  {
    // Build output, dependencies, generated code and the docs site.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'website/**',
      'clients/**',
      'apps/backend/prisma/migrations/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      /*
       * `any` is reported by tsc where it matters and appears deliberately here
       * in provider adapters and Prisma JSON columns, where the shape genuinely
       * is unknown until it is validated. Warning on every one would bury the
       * findings that mean something.
       */
      '@typescript-eslint/no-explicit-any': 'off',
      // An unused argument named `_x` is a documented signature, not dead code.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      /*
       * Matching a control character is what several of these functions are FOR.
       * `sanitizeSegment` and the discovery identity normaliser strip
       * `\u0000-\u001F` and the invisible-format range so a provider cannot
       * produce a deceptive filename; flagging that would be flagging the
       * mitigation.
       */
      'no-control-regex': 'off',
      /*
       * Off, deliberately. It flags the initialise-then-assign-inside-`try`
       * pattern this codebase uses throughout — `let x = false;` followed by a
       * `try` that sets it and a `catch` that returns early. The rule is right
       * that the initialiser is never read; removing it would trade a clear
       * default for a lint score and invite definite-assignment errors from
       * `tsc`, which is the tool that actually reasons about this.
       */
      'no-useless-assignment': 'off',
      /*
       * Off for now. Attaching `cause` to a rethrown error is a real
       * improvement, but it changes the shape of thrown errors across provider
       * clients, and that belongs in a change about error handling rather than
       * in the one that makes the linter run for the first time.
       */
      'preserve-caught-error': 'off',
      /*
       * A zero-width space inside a regex is deliberate here — it is how an
       * `@everyone` mention is defused before a Discord post, and the test for
       * that has to contain the character. Irregular whitespace in CODE is still
       * an error; in strings, templates and expressions it is data.
       */
      'no-irregular-whitespace': [
        'error',
        { skipStrings: true, skipTemplates: true, skipRegExps: true, skipComments: false },
      ],
    },
  },
  {
    /*
     * React's rules of hooks, for the frontend only.
     *
     * Installed because the code already carries
     * `// eslint-disable-next-line react-hooks/exhaustive-deps` comments in
     * seven places: somebody reached for this rule, found it unenforced, and
     * left a note for a linter that never ran. Wiring the plugin makes those
     * comments mean what they say — and makes the next missing dependency an
     * error rather than a silent re-render bug.
     */
    files: ['apps/frontend/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Tests reach into internals on purpose: non-null assertions and casts are
    // how a spec drives a private path without exporting it for the test.
    files: ['**/*.spec.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      /*
       * `require` is how a spec reaches the real module it is spying on —
       * `jest.requireActual`, or grabbing `node:fs/promises` to wrap one export.
       * An import statement is hoisted and would defeat the mock.
       */
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
