# The app's own words, as an editable file

`element26-copy.txt` is every string Element 26 shows on screen, pulled straight out of
`index.html`, each one under a stable `[T####]` id. It exists so the writing can be edited
away from the code and put back exactly.

- `extract.py` walks the `<script>` blocks, collects string and template literals, and
  filters out anything that is code rather than copy (selectors, CSS, SVG paths, keys).
- `build.py` groups identical strings, gives each one an id, files it under the part of the
  app it belongs to, and writes `element26-copy.txt` plus `copy-index.json` (id → text and
  the line numbers it appears on).

`multi.py` writes `element26-copy-paragraphs.txt`: the same ids, filtered to the blocks
that are more than one sentence and stand on their own — no fragment the app joins to
another fragment at runtime, so each one can be rewritten freely. 326 of the 2,262.

Round trip: edit the text under each id in `element26-copy.txt`, hand it back, and the
edits are applied to `index.html` by matching each id's original text at its recorded
lines. Regenerate after any change to the app's wording:

    python3 tools/copy/extract.py tools/copy/copy.json && python3 tools/copy/build.py
