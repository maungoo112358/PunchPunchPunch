import { defineConfig } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

// Lets us `import data from "./foo.yaml"` and get a plain JS object. The YAML is parsed at build/serve
// time, so the shipped bundle contains only the resulting data, no YAML parser. Used for the prop
// placements and the editor key bindings.
function yamlPlugin() {
  return {
    name: "yaml-loader",
    transform(code, id) {
      if (!id.endsWith(".yaml") && !id.endsWith(".yml")) return null;
      const data = yaml.load(code) ?? null;
      return { code: `export default ${JSON.stringify(data)};`, map: null };
    },
  };
}

// Pull the block of comments off the top of a YAML file so we can put it back after rewriting it.
//
// Why this exists: js-yaml writes data, and a comment is not data. So dumping the prop list over the file
// used to wipe every comment in it, including the header that explains what the fields mean. You would
// press Ctrl+S once and the documentation was just gone. We read the file first, keep the run of comment
// lines at the very top, and re-attach it to the new text.
//
// Only the top block survives. A comment sitting between two entries is still lost, because once the list
// is JSON there is nothing left to say which entry it belonged to. The header is the part worth keeping.
function readHeaderComment(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return ""; // no file yet, so no header to keep
  }
  const head = [];
  for (const line of text.split(/\r?\n/)) {
    // Stop at the first line that is neither a comment nor blank: that is where the data starts.
    if (!line.startsWith("#") && line.trim() !== "") break;
    head.push(line);
  }
  while (head.length && head[head.length - 1].trim() === "") head.pop(); // trim trailing blanks
  return head.length ? `${head.join("\n")}\n\n` : "";
}

// DEV-ONLY endpoint the placement editor posts to when you press Ctrl+S. It takes the current prop list
// as JSON and writes it back to src/config/propPlacements.yaml as tidy YAML, keeping the file's header
// comment. apply: "serve" keeps it out of production builds entirely.
function propSavePlugin() {
  const file = resolve("src/config/propPlacements.yaml");
  return {
    name: "prop-save",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__save-props", (req, res, next) => {
        if (req.method !== "POST") return next();
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const props = JSON.parse(body);
            // Read the old header BEFORE we overwrite the file, then put it back on the front.
            const header = readHeaderComment(file);
            // lineWidth: -1 stops js-yaml wrapping our number arrays onto multiple lines
            const text = header + yaml.dump(props, { lineWidth: -1 });
            writeFileSync(file, text);
            res.statusCode = 200;
            res.end("ok");
            server.config.logger.info(`saved ${props.length} props to propPlacements.yaml`);
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
    },
  };
}

// host: true binds the dev server to 0.0.0.0 so other devices on the network (your
// phone) can reach it — Vite prints a "Network:" URL alongside the localhost one.
export default defineConfig({
  plugins: [yamlPlugin(), propSavePlugin()],
  server: {
    host: true,
    // Allow tunnel domains (*.loca.lt, *.trycloudflare.com) through Vite's host check —
    // needed to reach the WSL2 dev server from a phone. Dev-only; fine to leave open.
    allowedHosts: true,
  },
});
