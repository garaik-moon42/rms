import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve("appsscript.json");
const target = resolve("build", "appsscript.json");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
