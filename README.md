# PunchPunchPunch

A small 3D web game. You walk a character around a tiny round planet covered in windy grass. The look is a cozy morning: warm sun, soft blue sky, drifting clouds. Multiplayer is planned.

Built with Three.js for the 3D, and Vite for the dev server. Runs in the browser. No game editor.

## What you need

- Node.js version 18 or newer. (Built and tested on Node 22.)
- npm. It comes with Node.
- A browser that supports WebGL, like Chrome, Brave, Edge, or Firefox.

To check if you have Node:

```bash
node -v
npm -v
```

If both print a version number, you are good.

## Install

Clone the repo, then install the packages.

```bash
git clone <repo-url>
cd PunchPunchPunch
npm install
```

`npm install` reads `package.json` and pulls in Three.js and Vite. It only needs to run once, or again when the packages change.

## Run it

Start the dev server:

```bash
npm run dev
```

Vite prints a local address, usually `http://localhost:5173`. Open it in your browser and the game loads. The server hot-reloads, so when you save a file the page updates on its own.

To stop the server, press `Ctrl + C` in the terminal.

## Controls

Desktop:

- WASD or arrow keys to move.
- Hold Shift to walk. Let go to run.
- Left-mouse drag to swing the camera around.

Phone (hold it upright):

- Bottom-center joystick to move. Push it soft to walk, full to run.
- Drag anywhere else to swing the camera.

## Test on your phone

The dev server is set to be reachable by other devices on your network. When you run `npm run dev`, Vite also prints a `Network:` address. Open that address on your phone, as long as the phone is on the same wifi.

Add `?debug` to the end of the address to get an on-screen console on the phone. That helps when there is no way to open the browser tools.

## Build for release

Make a production build:

```bash
npm run build
```

The finished files land in a `dist` folder. To preview that build before you ship it:

```bash
npm run preview
```

## Project layout

```
src/
  main.js       sets things up and runs the frame loop
  config/       all the scene colors in one place
  core/         renderer, camera, stats
  world/        lights, planet, grass, sky, pond
  entities/     the character
  systems/      input, camera follow, controls
public/models/  the 3D character files
```

## Credits

- Characters: Quaternius "Ultimate Animated Characters" (CC0, free to use).
- Nature props: Stylized Nature MegaKit.
