// The one Node function the fixture generator needs, declared by hand.
//
// Everything else in src/ runs in a browser, so the project has no Node type definitions and does not
// want the whole @types/node package pulled in just for a script that writes one file. Adding a
// dependency also means an npm install, which on this project has to happen from Windows.
declare module "node:fs" {
  export function writeFileSync(path: string, data: string): void;
}
