import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve("appsscript.json");
const target = resolve("build", "appsscript.json");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);

for (const fileName of readdirSync(resolve("src"))) {
  if (!fileName.endsWith(".html")) {
    continue;
  }

  copyFileSync(resolve("src", fileName), resolve("build", fileName));
}
