import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "eslint/config";
import type { Rule } from "eslint";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintPluginPrettier from "eslint-plugin-prettier";
import tseslint from "typescript-eslint";

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

// ─── Custom rules ────────────────────────────────────────────────────────────

const banEslintDisableRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Bans eslint-disable comments — fix the underlying issue",
    },
  },
  create(context) {
    return {
      Program() {
        const comments = context.sourceCode.getAllComments();
        for (const comment of comments) {
          const text = comment.value.trimStart();
          if (
            text.startsWith("eslint-disable") ||
            text.startsWith("eslint-enable")
          ) {
            context.report({
              loc: comment.loc ?? { line: 1, column: 0 },
              message:
                "eslint-disable comments are forbidden — fix the underlying issue instead",
            });
          }
        }
      },
    };
  },
};

// ─── Custom plugin ───────────────────────────────────────────────────────────

const customPlugin = {
  rules: {
    banEslintDisable: banEslintDisableRule,
  },
};

// ─── Config ──────────────────────────────────────────────────────────────────

export default defineConfig(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/pnpm-lock.yaml",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
    plugins: {
      prettier: eslintPluginPrettier,
      custom: customPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "custom/banEslintDisable": "error",
      "no-restricted-syntax": [
        "error",
        {
          message:
            "Dynamic imports are forbidden — use static imports instead.",
          selector: "ImportExpression",
        },
        {
          message:
            "Inline type imports via import() are forbidden — use a static import instead.",
          selector: "TSImportType",
        },
      ],
      "prettier/prettier": "error",
    },
  },
  eslintConfigPrettier,
  {
    files: ["**/*.json"],
    language: "json/json",
    plugins: { json },
    rules: {
      "json/no-duplicate-keys": "error",
    },
  },
  {
    files: ["**/*.md"],
    language: "markdown/gfm",
    plugins: { markdown },
    rules: {
      "markdown/no-html": "off",
    },
  },
);
