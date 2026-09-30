---
name: Arte generativa (p5.js)
slug: p5js-sketch
description: Arte generativa, visualizações e esboços interativos numa única página HTML.
category: Criatividade
requires: []
source: Hermes Agent, © 2025 Nous Research (MIT)
license: MIT
default: false
original: p5.js Creative Coding
---

Produce interactive and generative visual art with p5.js, delivered as one self-contained HTML file (p5.js from CDN, no build step). Write it with write_file; the Commander opens it in a browser.

Use for generative art, data visualisations, interactive canvas experiences, motion graphics, 3D (WebGL) scenes, or audio-reactive visuals.

## Creative standard
- **Articulate the concept BEFORE coding.** What does the piece communicate? What makes a viewer stop scrolling? If it would look like a p5.js tutorial exercise or a default config, rethink it.
- **First render must be striking.** Never a flat white background. Compositional hierarchy, intentional color temperature, and micro-detail that rewards a close look.
- **Cohesion over feature count.** Three effects that share a visual language beat ten unrelated ones. Consistent stroke weights, harmonious motion speeds, one palette.
- **Give more than asked.** "A particle system" → particles with flocking, trailing echoes, depth fog, a breathing noise field. Add one detail they didn't request but will appreciate.

## Stack (single file)
```html
<script src="https://cdn.jsdelivr.net/npm/p5@1.11.3/lib/p5.min.js"></script>
```
Add `p5.sound.min.js` only for audio. Use WEBGL mode in `createCanvas(w,h,WEBGL)` for 3D/shaders. Export with built-in `saveCanvas()` (PNG) or `saveGif()` (GIF).

## Structure
`globals → setup() → draw() → helper fns → classes → event handlers`. Keep `draw()` readable; push detail into helpers/classes. Seed randomness so a good frame is reproducible.

## Pipeline
`CONCEPT → DESIGN → CODE → PREVIEW → EXPORT`
1. Name the mood, palette, and motion vocabulary.
2. Choose mode, canvas size, interaction model.
3. Write the single HTML file.
4. write_file it (`sketch-<name>.html`), tell the Commander to open it and resize the window to test responsiveness.
5. Wire an export key (e.g. `if (key==='s') saveCanvas('art','png')`).
