import { readFileSync } from "node:fs";

/** Source and packaged services both keep their version at the product root. */
export const productVersion: string = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;
