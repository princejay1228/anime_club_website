# Benio rig: what's live, and what still needs new art

Built from **Benio Sakuraba Animation Rig v3** (SIMATS Anime Club).

## Live on the site
`benio-rig.js` draws Benio from her 28 original painted layers plus the v3 face rig, in the kit's documented order:
parts in z-order, the skin repair plate right after `16_face`, eye and mouth sprites swapped in for layers 17/18/19, and the effect overlay last.

| Feature | Source |
|---|---|
| Heart-hands body | Original 28 layers |
| Blinking (9 frames at 12 fps, every 3-6 s, occasional double blink) | v3 eye states: open, quarter, half, almost_closed, closed |
| Winks | Same frames, one eye only |
| Talking | v3 mouth shapes (a/e/i/o/u/m/f/l/rest) chosen from the letters she is saying |
| 29 expressions (happy, excited, laugh, shy, thinking, surprised...) | v3 `expressions` presets: eye pair + mouth + effect |
| Effects (blush, sparkles, question mark, sweat, tears...) | v3 cheek/brow overlays |
| Idle life | Tail sway, ear twitches, hair ornament and obi swing, breathing, hop |

Where she appears: the footer (tap her, tap five times, or type `sakura` / `benio`) and her self-introduction beat after the team intro, where her mouth moves while the bubble types.

## Not used: v3 hands, sleeves and legs
The v3 hand gestures, sleeves and legs are flat vector shapes. The kit says they are "not perfectly matching or seamlessly attachable", and that waving or pointing needs a newly painted neutral torso under the moved arms. Next to her painted body they would look pasted on, so the site keeps her painted heart pose.

To add waving, pointing, explaining, thinking or celebrating, the art needed per pose is:
- a painted arm, sleeve and hand in her style, and
- the painted kimono or bodice area that the moved arm uncovers,

all on the same 1122 x 1402 canvas as `Benio_CHIBI_master_transparent_1122x1402.png`. A full picture of her in each pose at that size also works: I can split it into layers and add them to `rig.json`.

## How new faces are layered (method used for the closed eyes)
1. Start from a full painting of Benio in the same pose as the master, showing the new expression (for example the closed-eyes heart-hands artwork).
2. Align it to the 1122 x 1402 master canvas automatically with feature matching (ORB keypoints + RANSAC similarity transform), so every pixel lines up with her rig.
3. Cut the changed region (the eyes) using the original eye layer's shape, widened ~14 px and feathered, so the edges blend into her real skin and blush.
4. Save it as a sprite with its canvas x/y in `rig.json`; the rig draws it in place of the original eye layer, with `20_hair_front` still drawn over it.

`face/eye_left_closed_painted.webp` and `face/eye_right_closed_painted.webp` were made this way and serve the closed, happy-closed and wink states. The same method works for any new expression or pose you supply as a full painting.
