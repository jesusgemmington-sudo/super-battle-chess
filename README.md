# ♟ Super Battle Chess

Multiplayer battle chess for **1v1** and **2v2**, with two rule sets:

**⚡ Battle** — real-time, **no turns, no mercy**. Inspired by the frantic
simultaneous-play energy of *Super Battle Golf*: both teams move at the same
time, every piece has a short cooldown after moving, and the first team to
**capture the enemy king** wins.

**👑 Grandmaster** — the complete laws of chess (turns, check, checkmate,
castling, en passant, promotion choice, stalemate, 50-move rule, threefold
repetition) plus a perfectly fair power-up economy. Every turn banks **+1⚡**
for both sides alike — no randomness, no hidden information — and energy buys:

| Power-up | Cost | Effect |
|---|---|---|
| 🛡 **Aegis** | 4⚡ | Shield a piece (not the king) — it can't be captured until your next turn begins. Cast freely before your move. |
| 🐴 **Knight's Spirit** | 6⚡ | One piece (not the king) may make a knight-jump as its move. Can capture pieces, never a king. |
| 🌀 **Second Wind** | 10⚡ | After your move, move a second, different piece. The bonus move can't capture or give check, and is forfeited if your first move gave check. |

Checkmate detection is power-up aware: it isn't mate if a 6⚡ knight-jump can
still save the king. In 2v2 Grandmaster, teammates alternate the team's moves.

## Quick start

Requires [Node.js](https://nodejs.org) 18+ (already installed if Claude set this up for you).

```
npm install
npm start
```

Then open **http://localhost:3000** — or just double-click `Play Super Battle Chess.bat`.

## Playing with friends

1. Click **Create a Game** and share the 4-letter room code (or the **Copy link** button).
2. Friends open the same site, enter the code, and pick a team.
3. The host picks **1v1** or **2v2** and a speed, then hits **Start Battle!**

**Same Wi-Fi / LAN:** the server prints a `Friends on LAN: http://192.168.x.x:3000`
address when it starts — friends on your network open that URL.

**Over the internet:** easiest options:
- [Tailscale](https://tailscale.com) — friends use your Tailscale IP.
- A quick tunnel, e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000` — share the generated URL.
- Or port-forward TCP 3000 on your router and share your public IP.

## How Battle mode plays

- ⚡ **No turns.** Anyone can move any of their team's pieces at any moment.
- ⏳ **Cooldowns.** After a piece moves it rests for a few seconds (host picks: 🐢 Chill 4.5s, ⚔️ Classic 3s, 🔥 Frenzy 1.5s).
- 👑 **Win by capturing the king.** There is no check or checkmate — guard your king with your life.
- 🤝 **2v2:** both teammates control the same army simultaneously. Coordinate or perish.
- ♟ Pieces move like normal chess pieces. Pawns auto-promote to queens. No castling or en passant in the battle arena.
- 😂 Spam emotes responsibly.

## How Grandmaster mode plays

- ♟ **Real chess.** Strict turns, full legality (pins, castling rules, en
  passant, promotion with under-promotion), check and checkmate, stalemate and
  draw rules. Win by checkmate or resignation — kings are never captured.
- ⚡ **Energy.** Both teams gain exactly +1 per own turn (cap 12). Spend it on
  the three power-ups above; your opponent always sees your energy and active
  effects, so every threat is readable — pure skill, zero RNG.
- 🤝 **2v2:** teammates alternate making the team's moves.
- 🏳 A resign button exists for the honorable.

## Tech

Lightweight on purpose: a single Node.js server (`ws` is the only dependency)
serving a vanilla HTML/CSS/JS client. No build step. Game logic is validated
server-side; movement rules are shared between server and client via
`public/rules.js`.
