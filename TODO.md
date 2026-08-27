# To-do

## Features
- [ ] **Screenshot → board importer.** Read a game screenshot (or a card exported
  from this tool) and auto-fill the grid and bench with the Tatari it detects.
  Runs fully in the browser, no backend: precompute a fingerprint (perceptual
  hash / small embedding) for each of the 224 roster sprites, crop the
  screenshot's cells, and match each to the nearest fingerprint. Scoped to clean
  in-game screenshots and this tool's own board/cards, not camera photos.
