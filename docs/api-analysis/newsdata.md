# API analysis — NewsData.io (default news provider)

**Status:** adapter shipped; probe requires a key. Go/no-go: **GO** (free
credits tier acceptable for 4 pulls/day with club rotation).

- Auth: `apikey` query param; credit-based free tier (~200 credits/day).
- Query length capped (~100 chars) → per-club query packs, clubs rotated
  across the day's pulls (5 clubs per pull).
- Articles are UNTRUSTED CONTENT — AI input only. Dedup: canonical URL +
  title trigram ≥0.9 within 72 h. Source tiers: BBC/Sky/Athletic/PL = 1.
- Entity linking via the alias table; a mononym/surname alias links only
  with club co-mention (club-context rule) — verified in unit tests.
- NewsAPI.org stays the paid-deploy alternate (24 h delay on free makes it
  useless for injury news); GNews is the reserve slot.
