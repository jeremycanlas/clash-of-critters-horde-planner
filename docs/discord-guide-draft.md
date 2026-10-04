# Discord guide draft: Horde Drafter

Paste-ready posts for the Discord guide contest, one per message (Discord caps a
message at 2,000 characters; each here is under 1,200). Attach the picture named
under a post to that post. The guide page and its links work once the
`guide-contest` branch is pushed.

Site: https://jeremycanlas.github.io/clash-of-critters-horde-planner/
Guide page: https://jeremycanlas.github.io/clash-of-critters-horde-planner/guide.html

Pictures, all in this repo:
- `docs/media/guide/arena-factor.png`: every line's Arena Factor (redraw: `node tools/guide-images.mjs`)
- `docs/media/guide/horde-lv7.png`: the 10 biggest Lv 7 Horde hits
- `assets/img/guide/card.webp`: what a shared formation looks like in chat
- `assets/img/guide/drafter.webp`, `share.webp`, `skills.webp`: phone screenshots

---

## Post 1: what it is

**Horde Drafter: plan your board before you spend a single resource** 🐾

A free, fan-made planner for **Horde Invasion, Gold Rush and Arena**, built by me (jacc6475).

- Build a formation in a minute, on phone or computer, no account
- Plan **co-op live** with your partner on one board
- Post it here as a clean picture or a link
- Every skill's real numbers, **read off the game itself**, including the Arena Factor most people never see

Full guide with pictures: https://jeremycanlas.github.io/clash-of-critters-horde-planner/guide.html

📎 attach: `assets/img/guide/drafter.webp`

## Post 2: build a formation (phone)

**1 · Build in a minute**
1. Open the **Drafter**, pick **Solo**, **Co-op** or **Gold Rush** at the top (Gold Rush is the 5 × 5 field, same as Arena)
2. Tap **Roster**, tap a Tatari, tap a square
3. Tap the chips under the field to move one; double-tap to take it off
4. **Plan** = who to level first, in order. **Summary** = every heal, buff and debuff the board brings
5. Undecided square? Turn on **Flex slots** and mark it "anyone's choice"

Your formations stay in your browser until you post one.

## Post 3: co-op, live

**2 · Co-op Horde, together and live**
- Switch to **Co-op**; the **P1 / P2** tabs pick whose side you're placing
- **Formation ▾ → Live → Start a live session**, send your partner the link
- You both edit the same board and see each other's moves as they happen. No account, phone or computer

## Post 4: share and Community

**3 · Share it here**
- **Share** → **Grid only** (reads at a glance in chat) or **Everything** (benches + level-up plan)
- **Download PNG**, **Copy image** or **Copy link**. A link opens the exact board, ready to edit
- **Post to Community** (bottom of Share) puts it in the public gallery
- Browse builds: https://jeremycanlas.github.io/clash-of-critters-horde-planner/community.html
  - Co-op only: …/community.html?mode=coop · Gold Rush only: …/community.html?mode=goldrush

Phone tip: **Just the grid** hides everything but the field, so a normal screenshot comes out clean.

📎 attach: `assets/img/guide/card.webp`

## Post 5: Arena Factor (the one people screenshot)

**4 · Why your skills hit softer in Gold Rush & Arena**
When a skill hits **another Tatari**, its damage is multiplied by its **Arena Factor**. Horde is not affected.

From the numbers read off the game, 66 lines:
- The middle line keeps **50%**. 41 of 66 keep half or less
- Only the **Glowfly** line hits *harder* (150%). **Zaplet** keeps 100%
- **Clucky** and **Cheerling** keep just 20%
- **DPS** lines keep the least on average (43%). A DPS that tops a Horde board can fall flat in Arena

Every line's factor is in the Skill data list: https://jeremycanlas.github.io/clash-of-critters-horde-planner/skills.html

📎 attach: `docs/media/guide/arena-factor.png`

## Post 6: Horde Invasion skills

**5 · Horde Invasion skills: Lv 3, 5, 7**
Each line learns three extra skills as it levels during a Horde run, the same three from T1 to T4. That's why the level-up order on **Plan** matters.

The biggest single Lv 7 hits: **Voltkit** (Bolt Slash, 600%), **Tindercub** (Flame Fists, 580%), **Joeyo** (Super Launch!, 525% × 7 hits). All 66 lines with their numbers are on Skill data. Link one Tatari straight: …/skills.html#glowfly

📎 attach: `docs/media/guide/horde-lv7.png`

## Post 7: also on the site

**Also on the site**
- **Patch notes**: every buff and nerf, Tatari by Tatari
- **Chips** and **Cozy Farm** reward tables
- **Record a range**: help fill in the attack ranges the wiki doesn't have

Fan-made and free. Found something wrong? Tell me here 🙏

---

### Still open before posting

- Starter co-op formations: 3–5 share links, each with a name and one line on when to use it (could be Post 4b)
- Numbers in Posts 5 and 6 come from `node tools/guide-page.mjs` output on guide.html; recheck them there after a patch
