# Emerald Menu Pixel

A custom pixel font inspired by the generated emulator interface mockups. This is a reconstruction of their general lettering style, not an exact extraction or an official Pokémon font.

## Files

- EmeraldMenuPixel-Medium.ttf: desktop/installable font; open and choose Install.
- EmeraldMenuPixel-Medium.woff: webfont.
- font.css: ready-to-use CSS; keep alongside the WOFF and apply the pixel-ui class.
- font-preview.png: specimen rendered using the actual TTF.
- build_font.py: editable glyph patterns and reproducible font-building source. Requires Python, fonttools and Pillow.

## Coverage and rendering

116 mapped characters: printable ASCII, selected accented Latin letters including é, multiplication sign, arrows, triangle indicators, curly quotes and dashes. One weight (500), proportional spacing, no kerning or hinting. Not a complete multilingual typeface.

Use 20px, 30px or 40px at native display scale to align the pixel grid. Browser zoom and fractional display scaling can soften pixel edges. The font file has been reopened and its printable ASCII coverage checked; the preview was rendered with Pillow. No cross-browser rendering QA has been performed.

## Permission

You may use, modify, embed and redistribute the supplied font and source, including commercially. No endorsement by or affiliation with Pokémon or Nintendo is implied.
