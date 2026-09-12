import { fixupConfigRules } from "@eslint/compat";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default tseslint.config(
  { files: ["**/*.{js,cjs,ts,tsx}"] },
  {
    ignores: ["**/dist", "eslint.config.mjs"],
  },
  ...fixupConfigRules(
    compat.extends(
      "@jetbrains",
      "@jetbrains/eslint-config/react",
      "@jetbrains/eslint-config/browser",
      "plugin:react-hooks/recommended",
    ),
  ),
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-refresh": reactRefresh,
    },

    languageOptions: {
      globals: {
        ...globals.browser,
      },

      parser: tseslint.parser,
    },

    rules: {
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
        },
      ],
      "react/jsx-no-literals": "off"
    }
  },
  {
    // The app backend runs inside YouTrack, not in Node or a browser. It must
    // use require(), and it copies the Asyntai API field names verbatim, which
    // are snake_case. Both rules are turned off for that one file only.
    files: ["src/*.js"],

    languageOptions: {
      globals: {
        ...globals.node,
      },
    },

    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "camelcase": "off",
      "func-names": "off",
    },
  },
);
