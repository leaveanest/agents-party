import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: [".serena/**", "terraform/**/.terraform/**"],
  },
  lint: {
    ignorePatterns: [".serena/**", "terraform/**/.terraform/**"],
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
