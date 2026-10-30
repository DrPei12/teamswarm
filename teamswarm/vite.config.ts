import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
export default defineConfig({
  resolve: {
    // TypeScript is authoritative when a local tool has emitted a sibling .js file.
    extensions: [".mts", ".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"],
  },
  plugins: [
    react(),
    {
      name: "teamswarm-public-assets",
      apply: "build",
      generateBundle(_options, bundle) {
        const modules = [
          ...new Set(
            Object.values(bundle).flatMap((entry) =>
              entry.type === "chunk" ? Object.keys(entry.modules) : [],
            ),
          ),
        ].filter((id) => !id.startsWith("\0") && id.includes("node_modules"));
        mkdirSync(path.resolve("../.codex-local"), { recursive: true });
        writeFileSync(
          path.resolve("../.codex-local/frontend-modules.json"),
          JSON.stringify(modules),
        );
      },
      writeBundle(options) {
        const output = options.dir!;
        mkdirSync(path.join(output, "branding"), { recursive: true });
        copyFileSync(
          path.resolve("branding/logo.ico"),
          path.join(output, "branding/logo.ico"),
        );
        for (const directory of ["cmaps", "standard_fonts"]) {
          const source = path.resolve("../node_modules/pdfjs-dist", directory);
          const target = path.join(output, "pdf", directory);
          mkdirSync(target, { recursive: true });
          for (const file of readdirSync(source, { withFileTypes: true })) {
            if (file.isFile())
              copyFileSync(
                path.join(source, file.name),
                path.join(target, file.name),
              );
          }
        }
        for (const file of ["fonts/InterVariable.woff2", "fonts/LICENSE.txt"]) {
          const target = path.join(output, file);
          mkdirSync(path.dirname(target), { recursive: true });
          copyFileSync(path.resolve("public", file), target);
        }
      },
    },
  ],
  build: {
    copyPublicDir: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (/@xyflow|d3-/.test(id)) return "graph";
            if (/@radix-ui|radix-ui/.test(id)) return "controls";
            if (/node_modules[\/](react|react-dom|scheduler)[\/]/.test(id))
              return "react";
            if (
              /react-markdown|remark-|micromark|mdast|hast|unified|vfile|unist|decode-named-character/.test(
                id,
              )
            )
              return "markdown";
            if (/motion|framer/.test(id)) return "motion";
          }
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.TEAM_API_PORT || "4318"}`,
        changeOrigin: false,
      },
    },
  },
});
