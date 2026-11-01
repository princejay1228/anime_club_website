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

**Guided scrolling:** the page moves in beats, one scroll gesture (wheel flick, swipe, arrow/space/page key) per beat: sakura tree → oni mask → SIMATS logo → President → Vice President → Secretary → Treasurer → closing line → Benio → footer. Each glide plays the animation at a set pace (`DUR` in the script, in ms). Going down, one extra scroll while a glide is still playing skips ahead one beat (`SKIP_MS`), never more. Going up, an extra scroll is queued and plays after the current beat lands, so scrolling up from the footer always moves one beat at a time and can't race back to the top. Scrolls in the first `TAIL_MS` of a glide are treated as the end of the same gesture (mouse-wheel notches, swipe momentum). A phone fling coming up out of the footer is stopped at the join section and handed to the guide. Everything reverses when scrolling back up. The whole sequence takes about 30 seconds with one flick per beat.

## Files

- `index.html` — all markup, CSS and JavaScript (Canvas 2D tree, petals, mask and eye glow; SVG logo).
- `assets/oni-mask.js` — the oni as a vector path. It's drawn on canvas each frame, so it stays sharp at any zoom.
- `assets/oni-gold-v3.svg` / `assets/oni-gold-v3.png` — the same mask as a standalone SVG and a 1872×2756 transparent PNG.
- `assets/fonts/` — Dela Gothic One (logo subset) and Manrope, both under the SIL Open Font License.

## Team photos and narrator

At the top of the script, find the `TEAM INTRO` block:

- `TEAM`: each officer's `role`, `name`, `line` (what the narrator says) and `photo`. Put an image in `assets/team/` and set e.g. `photo:'assets/team/president.jpg'`. While `photo` is `''`, an original placeholder character is shown with a PHOTO SOON tag. For a photo with its background removed (a transparent cut-out, like `assets/team/secretary-jayadeep.webp`), also set `cutout:true` so the person stands in the panel like the placeholder figures instead of filling the screen. On phones the cut-out sits behind the narrator's semi-transparent speech bubble, with the face kept clear. A close-up photo (head and shoulders, like `assets/team/vp-darshan.webp`) can be sized and placed with `photoH` and `photoL` (desktop height and horizontal centre, e.g. `'80%'`, `'17%'`), and `photoHm`, `photoBm` and `photoLm` (phone height, distance from the bottom and horizontal centre) so the face sits between the name and the bubble.
- `NARRATOR_IMAGE`: currently `assets/narrator.webp`, the fox-girl from your reference image with its background removed. To change her, point it at another transparent PNG/WebP of the character you want as the narrator (e.g. `'assets/narrator.png'`). It walks, bobs and flips direction automatically. Set it to `''` to fall back to the simple built-in vector narrator.
- `NARRATOR_OUTRO_IMAGE`: her second pose (from your character sheet), cross-faded in on the closing screen. Set to `''` to keep the main pose.
- `OUTRO`: the closing line.
- `SELF`: the mascot's playful self-introduction after the closing line. She is **Sakuraba Benio (桜庭 紅緒)**, nickname Beni-chan. For this beat she switches to her live heart-hands rig: she talks while the bubble types, then lights up with sparkle eyes and a laugh as two hearts float up. `assets/benio-chibi.webp` is shown if the rig can't load.
- Guided scrolling: tune `DUR` (glide length into each beat), `SKIP_MS`, `ONI_STOP` (where the oni beat rests) and `STOP_U` (where each team beat rests). Links bypass it.
- `CLUB_CONTACT`: fill in the club's Instagram handle, email and WhatsApp community link to show them in the footer.

## Recent meets gallery

Below the join section, `#meets` shows photos and clips from recent meets in one row that drifts slowly sideways and never stops on hover or tap. Tapping a photo or clip opens it full-size in a viewer (arrows, swipe or ←/→ to browse, Esc or ✕ to close); the row pauses only while the viewer is open. Files live in `assets/meets/`. To add a new photo or clip, add a `<figure class="meet">` to **both halves** of `#meetsTrack` (the second half is a copy that makes the loop seamless). Clips are muted and only play while the gallery is on screen. Change the drift speed with `animation` on `.meets-track` (70s on desktop, 55s on phones).

The Join buttons and the footer link go to the club's WhatsApp community (`CLUB_CONTACT.whatsapp`).

## Site extras

- **Icons:** `favicon.ico`, `apple-touch-icon.png`, `assets/icon-192.png`, `assets/icon-512.png` and `site.webmanifest` use Benio's face on crimson.
- **Returning visitors:** after someone has watched up to the logo once, their next visit shows a small "Okaeri! Welcome back" card with *Replay intro* or *Skip to crew*. The flag lives in their browser (`simats_seen_intro`).
- **What We Do:** four tiles (Screenings, Cosplay, Art Jams, Quizzes & Fests) with hand-drawn gold icons.
- **Weekly meet calendar:** a cute month calendar marks every Tuesday as a club meet (`MEET`), greys out Tuesdays that are Tamil Nadu government holidays (`TN_HOLIDAYS`), and shows the next meet with *Join on WhatsApp*, a repeating *Google Cal* event and an *.ics* that skips holiday Tuesdays. Fill `MEET.time`, `MEET.end` and `MEET.venue` once fixed. The 2026 holidays come from the Tamil Nadu government list; for 2027 only fixed-date holidays are in, so add the rest when the 2027 G.O. is published.
- **Upcoming Events:** fill the `EVENTS` list near the top of the script (`title`, `start`, `end`, `venue`, `tag`, `desc`; times in IST). Each event gets *Google Cal* and *.ics* buttons; past events hide themselves. With no events it shows a "date to be announced, get notified" card linking to WhatsApp.
- **Benio easter eggs:** tap footer Benio and she says a random line from `BENIO_LINES` while blinking and talking. Tap her five times quickly for a secret, and type `sakura` or `benio` anywhere for a sakura storm.
- **Music:** an original soundtrack composed for the site and synthesised live in the browser by `assets/music.js` (Web Audio, no recordings or samples, so there's nothing copyrighted and nothing extra to download). The intro plays *Oni no Kodō*, aggressive taiko with a shamisen riff in the In scale. A temple gong strikes as the SIMATS logo appears. After that, 23 calm pieces play one after another and loop, starting at a random one on each visit. Three are hand-written: *Sakura no Niwa*, *Tsuki no Yashiro* and *Chaya no Kaze*. The other twenty, from *Ame no Engawa* (Rainy Veranda) to *Kaerimichi* (The Way Home), are written by a seeded melody composer in `music.js`, so each one always plays the same tune. Each has its own scale (hirajōshi, in, yō, kumoi, ritsu, ryūkyū), lead instrument (koto, shakuhachi, shinobue, shamisen, biwa, kokyū or temple bells), tempo and texture (soft taiko, wind chimes, rain or sea). To add a song, add a row to the list in `CALM` with a new seed. Scrolling back into the intro brings the drums back. Browsers only allow sound after a tap or key press, so first-time visitors see a small *Play with sound?* card, and a tap anywhere starts the music. During the intro the speaker button (bottom-left) mutes or unmutes. After the logo it opens a small player showing the song name (Japanese and English), a timeline you can tap to jump through the song (the player doesn't show how many songs there are), and previous, mute and next buttons (Esc or ✕ closes it). The on/off choice is remembered (`simats_sound`) and the music pauses while the tab is hidden.
- **Quote of the day:** below the calendar, a Japanese proverb, idiom or classic haiku for each date (India time), shown in Japanese, romaji, English and its meaning. `assets/quotes.js` holds 366 unique quotes keyed `MM-DD`, including 29 February, with festival matches such as 一年の計は元旦にあり on 1 January, 心機一転 on Tamil New Year (14 April), 実るほど頭を垂れる稲穂かな for Thai Pongal and the Tanabata haiku on 7 July. Visitors can also look at yesterday's quote; tomorrow's stays a surprise. Labels starting with `~` show as "… season" for festivals whose date moves each year.

## Benio rig

`assets/benio-rig/` holds Benio's 28 original painted layers and the v3 face rig: the skin repair plate, 18 eye states, 23 mouth shapes and 9 effect overlays. `rig.json` (also in `rig-data.js`) records every position, and `benio-rig.js` draws her live: 9-frame blinking, text-driven talking, 29 expressions, and tail, ear and ornament motion. She appears in the footer and in her self-introduction beat. `POSE_REQUESTS.md` explains what's live and what new art the arm poses still need.

## Footer and legal pages

- The footer uses a light washi-paper palette with traditional Japanese patterns drawn as small SVGs in `assets/patterns/`: seigaiha (overlapping waves) as a faint background, a row of curling wave crests along the top edge, gold kumo (auspicious cloud) motifs and two sakura blossoms.
- Benio sits in the footer making a heart with her hands, drawn live from her rig (blinking, talking, expressions, ear and tail motion). `assets/benio-heart-hands.webp` shows until the rig loads. Set `FOOTER_RIG` to `false` to show the still image `FOOTER_MASCOT` instead.

- `index.html` ends with a join section and a footer (about, explore links, contact, legal, copyright and an anime-rights disclaimer).
- `terms.html`, `privacy.html` and `conduct.html` are the Terms & Conditions, Privacy Policy and Code of Conduct. They are a general template for a student club; review them with the faculty coordinator so they match SIMATS policy.

## Tuning

- Petal amount: `initPetals()` (`1960*k`). Build-up and fade timing: `density()`.
- Tree shape: `drawTree()`, with the trunk path and the `arms` list.
- Eye position: `EYE_L` / `EYE_R` (mask units, 936×1378).
- Zoom strength: `zMax` in `render()`. Logo hold length: `HOLD_VH`. Total scroll length: `.experience` height in CSS.
- Club name: the `titleArt` and `banner` text in the logo SVG.

The logo is an original wordmark in a shōnen anime title style. It does not copy any existing show's logo.
