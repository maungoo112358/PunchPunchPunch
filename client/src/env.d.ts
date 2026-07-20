// Type info for the non-code things we import. A .d.ts file is declarations only: it describes shapes
// to the typechecker and produces nothing at runtime. Nothing imports this file, TypeScript just picks
// it up because it sits inside src.

// Pulls in Vite's own types. Without this, import.meta.env.DEV (the flag that keeps the prop editor and
// the grid gizmo out of release builds) is an error, because plain TypeScript has never heard of it.
/// <reference types="vite/client" />

// Our vite.config.js has a small plugin that reads a .yaml file and hands back a plain object. That all
// happens before TypeScript is involved, so on its own it thinks importing a .yaml file is nonsense.
// These two blocks tell it the import works and gives you a value.
//
// The value is `any` on purpose for now. Describing the real shape of the prop list is a separate job
// worth doing later, and today we only want the file extensions to stop being errors.
declare module "*.yaml" {
  const data: any;
  export default data;
}

declare module "*.yml" {
  const data: any;
  export default data;
}
