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
| hold | The finished logo stays on screen while you read it |
| header | Logo glides up and shrinks into a header bar |
| team | One officer fills the screen at a time (President → Vice President → Secretary → Treasurer → closing panel → Benio's self-intro); each new panel rises over the last as you scroll, while the narrator walks left → right → left → right and talks in a speech bubble |

**Guided scrolling:** the page moves in beats, one scroll gesture (wheel flick, swipe, arrow/space/page key) per beat: sakura tree → oni mask → SIMATS logo → President → Vice President → Secretary → Treasurer → closing line → Benio → footer. Each glide plays the animation at a set pace (`DUR` in the script, in ms). Scrolling again while a glide is still playing skips ahead to the following beat (`SKIP_MS`). Everything reverses when scrolling back up. The whole sequence takes about 30 seconds with one flick per beat.

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
- Guided scrolling: tune `DUR` (glide length into each beat), `SKIP_MS`, `ONI_STOP` (where the oni beat rests) and `STOP_U` (where each team beat rests). Links bypass it.
- `CLUB_CONTACT`: fill in the club's Instagram handle, email and WhatsApp community link to show them in the footer.

## Recent meets gallery

Below the join section, `#meets` shows photos and clips from recent meets in one row that drifts slowly sideways and never stops on hover or tap. Tapping a photo or clip opens it full-size in a viewer (arrows, swipe or ←/→ to browse, Esc or ✕ to close); the row pauses only while the viewer is open. Files live in `assets/meets/`. To add a new photo or clip, add a `<figure class="meet">` to **both halves** of `#meetsTrack` (the second half is a copy that makes the loop seamless). Clips are muted and only play while the gallery is on screen. Change the drift speed with `animation` on `.meets-track` (70s on desktop, 55s on phones).

The Join buttons and the footer link go to the club's WhatsApp community (`CLUB_CONTACT.whatsapp`).

## Footer and legal pages

- The footer uses a light washi-paper palette with traditional Japanese patterns drawn as small SVGs in `assets/patterns/`: seigaiha (overlapping waves) as a faint background, a row of curling wave crests along the top edge, gold kumo (auspicious cloud) motifs and two sakura blossoms.
- Benio sits in the footer making a heart with her hands (`assets/benio-heart-hands.webp`), gently bobbing, with a "Mata ne!" caption. To change her, point `FOOTER_MASCOT` at another transparent PNG/WebP in `assets/`.

- `index.html` ends with a join section and a footer (about, explore links, contact, legal, copyright and an anime-rights disclaimer).
- `terms.html`, `privacy.html` and `conduct.html` are the Terms & Conditions, Privacy Policy and Code of Conduct. They are a general template for a student club; review them with the faculty coordinator so they match SIMATS policy.

## Tuning

- Petal amount: `initPetals()` (`1960*k`). Build-up and fade timing: `density()`.
- Tree shape: `drawTree()`, with the trunk path and the `arms` list.
- Eye position: `EYE_L` / `EYE_R` (mask units, 936×1378).
- Zoom strength: `zMax` in `render()`. Logo hold length: `HOLD_VH`. Total scroll length: `.experience` height in CSS.
- Club name: the `titleArt` and `banner` text in the logo SVG.

The logo is an original wordmark in a shōnen anime title style. It does not copy any existing show's logo.
