import { defineConfig } from "vite";

// host: true binds the dev server to 0.0.0.0 so other devices on the network (your
// phone) can reach it — Vite prints a "Network:" URL alongside the localhost one.
export default defineConfig({
  server: {
    host: true,
    // Allow tunnel domains (*.loca.lt, *.trycloudflare.com) through Vite's host check —
    // needed to reach the WSL2 dev server from a phone. Dev-only; fine to leave open.
    allowedHosts: true,
  },
});
