import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Every tsconfig that names source files, so type-aware rules see the whole
 * repo. The `.tests.json` variants include `src` as well as `test`, and
 * `tsconfig.lint.json` covers the cross-cutting root files that belong to no
 * package. A file in none of these is a lint parse error rather than a silently
 * unlinted file, which is the failure mode worth having.
 */
const PROJECTS = [
  "./tsconfig.lint.json",
  "./app/tsconfig.tests.json",
  "./app/tsconfig.node.json",
  "./packages/cli/tsconfig.tests.json",
  "./packages/engine/tsconfig.tests.json",
  "./packages/format/tsconfig.tests.json",
  "./tools/dev-server/tsconfig.tests.json",
  "./tools/dev-server/tsconfig.web.json",
];

/**
 * A deliberately small rule set, chosen by measuring candidates against this
 * codebase rather than by adopting a preset.
 *
 * The house style is already enforced by a strict tsconfig — `strict`,
 * `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` — so most of what a
 * maximal preset would add here is either redundant with the compiler or an
 * argument with a decision already made. `typescript-eslint`'s
 * `strictTypeChecked` reports 1317 problems on this tree, of which 1173 are
 * three rules objecting to house style: `no-non-null-assertion` (a `!` after an
 * indexed read is how this codebase satisfies `noUncheckedIndexedAccess`),
 * `restrict-template-expressions` (interpolating an integer, in a format whose
 * every quantity is an integer), and `no-confusing-void-expression` (a React
 * event handler that calls a setter). A linter nobody can leave on is worth
 * less than no linter, so those are not enabled.
 *
 * `no-unnecessary-condition` is the notable omission. It found 14 problems, and
 * every one is deliberate: guards that re-check untrusted input the type system
 * has been *told* about via an assertion — `JSON.parse(body) as WriteRequest`,
 * a websocket frame — plus narrowing artefacts on class fields. Validating a
 * parsed wire message is exactly the defensive check this codebase wants, and a
 * rule that calls it dead code would train people to delete it.
 *
 * What is left fires on mistakes rather than on choices.
 */
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "tools/dev-server/build/**", "fixtures/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [js.configs.recommended],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: PROJECTS, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // Core rules that TypeScript itself handles, or that misfire on TS syntax.
      "no-unused-vars": "off",
      "no-undef": "off",
      "no-redeclare": "off",

      // Dead bindings and dead imports. `_name` stays exempt: an unused
      // parameter that a signature obliges you to accept is named, not deleted.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],

      // Promises: the three ways an async call silently does not happen.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      // `any` has to be written on purpose, and reviewable when it is.
      "@typescript-eslint/no-explicit-any": "error",

      // Comparisons and expressions that do not mean what they read as.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/no-for-in-array": "error",

      // Throwing and catching non-errors loses the stack.
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/no-implied-eval": "error",

      // A `switch` over a union that grows is the bug this catches.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],

      // `ignoreReadBeforeAssign` because the two places this fired are the same
      // deliberate idiom: a `let` a closure defined above it reads, assigned
      // once below. `const` is not available there, so the report was an
      // instruction to write code that does not compile.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      "no-var": "error",
    },
  },
  {
    // The config file itself: no type information to lint it with, and none needed.
    files: ["eslint.config.js"],
    extends: [js.configs.recommended],
  },
);
