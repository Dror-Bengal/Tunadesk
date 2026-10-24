// Bundle the built web app (and the agent skills) into the server package.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "..", "web", "dist");
const skills = join(root, "..", "skills");

rmSync(join(root, "public"), { recursive: true, force: true });
if (existsSync(web)) {
  cpSync(web, join(root, "public"), { recursive: true });
  console.log("copied web/dist → server/public");
} else {
  console.warn("web/dist not found — run `npm run build -w web` first (the API still works without the UI)");
}
if (existsSync(skills)) {
  rmSync(join(root, "skills"), { recursive: true, force: true });
  cpSync(skills, join(root, "skills"), { recursive: true });
}
