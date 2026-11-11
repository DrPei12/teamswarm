import { readFileSync } from "node:fs";

/** Source and packaged services both keep their version at the product root. */
export const productVersion: string = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;

function packagedBuild() {
  try {
    const identity = JSON.parse(readFileSync(new URL("../../../build-identity.json", import.meta.url), "utf8"));
    if (typeof identity.commit !== "string" || !/^[a-f0-9]{64}$/.test(identity.sourceSha256))
      throw new Error("Invalid packaged build identity.");
    return Object.freeze({ commit: identity.commit as string, sourceSha256: identity.sourceSha256 as string });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
/** Keep the identity of this process, even if an updater replaces files on disk. */
export const productBuild = packagedBuild();
