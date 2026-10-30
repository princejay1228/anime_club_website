# SIMATS Anime Club — Cinematic Intro V3

Open **index.html** in any modern browser. No build step, server or internet connection is needed (fonts ship in `assets/fonts`).

## Scroll timeline (progress 0 → 1)

| Progress | Scene |
|---|---|
| 0.00–0.18 | All-pink `#FFD6E3` sakura tree with gnarled, segmented branches; red sunset sky; small Mount Fuji on the right |
| 0.03–0.43 | Petal storm builds slowly to cover 50%+ of the screen (petals at 47°, 40% wider than V2) |
| 0.24–0.50 | Petals turn crimson; background becomes pure black |
| 0.46–0.80 | Petals thin out slowly while the gold oni emerges behind them |
| 0.66–0.72 | Round eyes switch on (dim `#780012`) in the mask's eye sockets |
| 0.70–0.83 | Camera zooms toward the eyes (brightness held) |
| 0.83–0.89 | Eyes brighten `#780012 → #B00020 → #DC0628`, glow spreads |
| 0.865–0.935 | Glow becomes a full deep crimson frame (`#900018`) and holds |
| 0.935–1.00 | Frame cools to black; SIMATS ANIME CLUB logo + ENTER |
| hold | The finished logo stays on screen for one extra screen of scrolling |
| header | Logo glides up and shrinks into a header bar |
| team | One officer fills the screen at a time (President → Vice President → Secretary → Treasurer → closing panel → Benio's self-intro); each new panel rises over the last as you scroll, while the narrator walks left → right → left → right and talks in a speech bubble |

Every scene has about 75% more scroll distance than V2, so the whole sequence plays slowly. Everything is driven by scroll position and reverses when scrolling back.

## Files

- `index.html` — all markup, CSS and JavaScript (Canvas 2D tree, petals, mask and eye glow; SVG logo).
- `assets/oni-mask.js` — the oni as a vector path. It's drawn on canvas each frame, so it stays sharp at any zoom.
- `assets/oni-gold-v3.svg` / `assets/oni-gold-v3.png` — the same mask as a standalone SVG and a 1872×2756 transparent PNG.
- `assets/fonts/` — Dela Gothic One (logo subset) and Manrope, both under the SIL Open Font License.

## Team photos and narrator

At the top of the script, find the `TEAM INTRO` block:

- `TEAM`: each officer's `role`, `name`, `line` (what the narrator says) and `photo`. Put an image in `assets/team/` and set e.g. `photo:'assets/team/president.jpg'`. While `photo` is `''`, an original placeholder character is shown with a PHOTO SOON tag.
- `NARRATOR_IMAGE`: currently `assets/narrator.webp`, the fox-girl from your reference image with its background removed. To change her, point it at another transparent PNG/WebP of the character you want as the narrator (e.g. `'assets/narrator.png'`). It walks, bobs and flips direction automatically. Set it to `''` to fall back to the simple built-in vector narrator.
- `NARRATOR_OUTRO_IMAGE`: her second pose (from your character sheet), cross-faded in on the closing screen. Set to `''` to keep the main pose.
- `OUTRO`: the closing line.
- `SELF`: the mascot's playful self-introduction after the closing line. She is **Sakuraba Benio (桜庭 紅緒)**, nickname Beni-chan. For this beat she switches to her chibi form (`assets/benio-chibi.webp`, from the SIMATS Fox Girl character kit), hops, and two hearts float up.
- Guided scrolling: inside the team section one wheel flick, swipe or arrow/space/page key glides to the next officer and stops once the narrator has finished. Tune `GLIDE_MS` (glide length) and `STOP_U` (where each stop rests). Skip/Enter/Join links bypass it.

## Tuning

- Petal amount: `initPetals()` (`1960*k`). Build-up and fade timing: `density()`.
- Tree shape: `drawTree()`, with the trunk path and the `arms` list.
- Eye position: `EYE_L` / `EYE_R` (mask units, 936×1378).
- Zoom strength: `zMax` in `render()`. Logo hold length: `HOLD_VH`. Total scroll length: `.experience` height in CSS.
- Club name: the `titleArt` and `banner` text in the logo SVG.

The logo is an original wordmark in a shōnen anime title style. It does not copy any existing show's logo.
