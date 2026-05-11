import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: [
      ".serena/**",
      "alembic/**",
      "pyproject.toml",
      "src/agents_party/**",
      "terraform/**/.terraform/**",
      "uv.lock",
    ],
  },
  lint: {
    ignorePatterns: [
      ".serena/**",
      "alembic/**",
      "src/agents_party/**",
      "terraform/**/.terraform/**",
    ],
  },
  pack: {
    clean: true,
    dts: false,
    entry: ["src/main.ts"],
    format: ["esm"],
    platform: "node",
    sourcemap: true,
    target: "node22",
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
