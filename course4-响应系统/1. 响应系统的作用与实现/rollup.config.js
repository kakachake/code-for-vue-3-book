import { defineConfig } from "rollup";
export default defineConfig({
  input: "./main.js",
  output: [
    {
      file: "./dist/bundle.iife.js",
      format: "iife",
      name: "xys",
    },
    { file: "./dist/bundle.esm.js", format: "es" },
    {
      file: "./dist/bundle.umd.js",
      format: "umd",
      name: "xys",
    },
  ],
});
