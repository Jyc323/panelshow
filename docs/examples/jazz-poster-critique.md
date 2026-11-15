# Example session: "Jazz night poster: critique, then redraw"

A real PanelShow session with models on GMI Cloud, recorded on 2026-11-14. The first draft (img-1) was made beforehand with gpt-image-2.5-sunburst-generate from a deliberately cluttered prompt and pasted in by the Host. Replies and prompts are unedited; the pictures are not stored in this repository.

Members: Juno (openai/gpt-6.1-sol, Art Director), Kerning (google/gemini-4-argon, Type Critic), Mira (Qwen/Qwen3.8-Max, Designer)

### Host

Here is the first draft of our jazz night poster. Critique it in at most 3 short bullets, and suggest one concrete change to the image prompt. Don't draw yet.

(attached picture: img-1)

### Juno (openai/gpt-6.1-sol)

- Strong neon jazz mood, but the poster is visually overloaded; the eye competes between the title, instruments, slogans, stars, and signs.
- “JAZZ NIGHT” is the intended focal point, yet the oversized lantern and many peripheral text blocks dilute its impact.
- Remove the left/right slogans, bottom chalkboards, extra musical notes, and most foreground instruments; keep one lantern, the title, and a restrained stage setup.

Concrete prompt change: “Create a clean, focused composition with only the BLUE LANTERN CLUB header, dominant JAZZ NIGHT title, date/time, one glowing lantern, and a small piano/microphone silhouette; remove all peripheral slogans, signs, extra instruments, stars, and decorative text.”

### Kerning (google/gemini-4-argon)

- **Collapsed hierarchy:** "THE BLUE LANTERN CLUB" and "JAZZ NIGHT" fight at nearly equal scale, while critical practical copy ("TICKETS $15 ADVANCE / $20 AT THE DOOR") is exiled to a tilted corner sign instead of living in the main reading axis.
- **Typeface soup & distance failure:** Using six different lettering styles across eleven scattered text blocks kills legibility from across a room—and the mic stand slices right through the bass drum text, turning "HERE" into gibberish ("HNERE").
- **No negative space around the letterforms:** Every neon glow, bulb marquee, and cursive flourish bleeds directly into props or adjacent text, leaving zero dark margin for the eye to lock onto the words.

**Concrete prompt change:** Specify a strict three-tier centered typographic hierarchy in a vertical `3:4` poster layout—*"Top small tracked-out sans-serif: 'THE BLUE LANTERN CLUB'; Center dominant vintage serif: 'JAZZ NIGHT'; Bottom clean sans-serif block: 'FRIDAY 8PM • $15 ADVANCE / $20 DOOR'—maximum two typefaces, wide dark margins around all text, and zero background signs, slogans, or text on instruments."*

@Mira, over to you.

### Mira (Qwen/Qwen3.8-Max)

- **No value script:** every element glows at full intensity, so nothing reads as "the light source" — the fix isn't only deleting props (Juno) but relighting: one key glow on the title/lantern, everything else dropped to near-black with thin rim light.
- **Brand color drift:** the club is the *Blue* Lantern, yet magenta and amber own the poster; lock the palette to a deep blue-teal night with a single warm accent reserved for "JAZZ NIGHT" so the title wins by hue contrast, not just scale.
- **Mixed media collage:** photoreal table props (cocktail, fedora, candle) sit beside flat vector music notes and cartoon neon signs; pick one rendering language — illustrated neon-on-brick — or the poster keeps feeling assembled from stock parts.

Concrete prompt change: "Relight and re-palette the scene: midnight-blue background with wide dark margins, one cool glowing blue lantern as the only ambient light, 'JAZZ NIGHT' as the sole warm amber marquee-bulb lettering at dominant scale, all instruments and furniture reduced to dark silhouettes with thin blue rim light, single illustrated neon-sign rendering style throughout, no secondary glows competing with the title."

I agree with Juno's cuts and Kerning's three-tier centered type stack (and the 3:4 format); those plus this relight are compatible, not competing. @Host, say the word and I'll merge all three into one final prompt and draw it.

### Host

@Mira go ahead: merge all three into one final prompt and draw it with gemini-3.1-flash-image, ar=3:4.

### Mira (Qwen/Qwen3.8-Max)

@@draw gemini-3.1-flash-image: Jazz club event poster, vertical 3:4 layout, clean focused composition with wide dark margins. Midnight-blue background in deep teal night tones. Strict three-tier centered typographic hierarchy: top small tracked-out sans-serif reading "THE BLUE LANTERN CLUB"; center dominant vintage serif "JAZZ NIGHT" rendered as warm amber glowing marquee-bulb lettering — the only warm light in the image and the clear focal point; bottom clean sans-serif block reading "FRIDAY 8PM • $15 ADVANCE / $20 DOOR". One cool blue glowing paper lantern hangs near the top as the sole ambient light source. Below the title, small dark silhouettes of an upright piano and a vintage microphone with thin blue rim light. Single illustrated neon-sign rendering style throughout; no other signs, slogans, stars, musical notes, chalkboards, instruments, or text anywhere else; generous negative space around all letterforms; high contrast, poster design. ar=3:4

### Mira drew → img-2 (gemini-3.1-flash-image, 11 s)

> Jazz club event poster, vertical 3:4 layout, clean focused composition with wide dark margins. Midnight-blue background in deep teal night tones. Strict three-tier centered typographic hierarchy: top small tracked-out sans-serif reading "THE BLUE LANTERN CLUB"; center dominant vintage serif "JAZZ NIGHT" rendered as warm amber glowing marquee-bulb lettering — the only warm light in the image and the clear focal point; bottom clean sans-serif block reading "FRIDAY 8PM • $15 ADVANCE / $20 DOOR". One cool blue glowing paper lantern hangs near the top as the sole ambient light source. Below the title, small dark silhouettes of an upright piano and a vintage microphone with thin blue rim light. Single illustrated neon-sign rendering style throughout; no other signs, slogans, stars, musical notes, chalkboards, instruments, or text anywhere else; generous negative space around all letterforms; high contrast, poster design.

### Host

@Juno @Kerning does img-2 fix what you raised? One sentence each.

### Juno (openai/gpt-6.1-sol)

It fixes the hierarchy, clutter, palette, and negative-space problems, but the title’s glow is still so dominant that it slightly competes with the lantern and leaves the piano/microphone visually stranded.

### Kerning (google/gemini-4-argon)

Yes, it nails the three-tier hierarchy, two-typeface discipline, and across-the-room legibility with zero spelling errors—though the lantern string slices directly through the 'R' in "LANTERN," creating a minor tangency that should be nudged cleanly below the baseline.
