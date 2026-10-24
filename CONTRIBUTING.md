# Contributing

wesnothweb2 is an **unofficial, fan-made port** of
[Battle for Wesnoth](https://www.wesnoth.org/) to the web. It is not affiliated
with, endorsed by, or part of the official Wesnoth project. All game content —
scenarios, units, campaigns, art, audio, and music — is taken verbatim from
upstream Wesnoth, which remains the sole source of truth for that content.

## What this repo accepts

Patches and bug fixes that are **specific to this port** are welcome,
including:

- Bugs in the TypeScript engine, UI, or build tooling that are unique to this
  codebase (i.e. not inherited directly from upstream's own logic).
- Changes that make this port's behavior **more faithful to upstream**'s —
  for example, fixing a combat/pathfinding/AI calculation that diverges from
  what the real engine does, or correcting a WML parsing edge case.
- UI/UX improvements for the web experience itself (layout, input handling,
  accessibility, performance, browser compatibility).
- Test coverage, tooling, and documentation for any of the above.

## What belongs upstream instead

This project does not maintain its own fork of Wesnoth's game content or
design decisions. If you have:

- New or changed **game data**: units, scenarios, campaigns, balance changes,
  translations, or anything else that lives in WML;
- New or changed **assets**: artwork, sprites, portraits, audio, or music;
- A **new gameplay feature** that doesn't exist in upstream Wesnoth;

please contribute it to [upstream Wesnoth](https://github.com/wesnoth/wesnoth)
first. Once it lands there, this port can pick it up the same way it picked up
everything else — by re-syncing from upstream's data — rather than by
maintaining a divergent copy here. This keeps the port's content in lockstep
with upstream and avoids forking a FLOSS project's creative work without
upstream's involvement.

If you're unsure whether something is "port-specific" or "upstream content,"
open an issue first and ask before sending a PR — it's a quick conversation
and saves everyone a rewritten patch.

## Before you send a PR

- Check `npm run typecheck --workspaces --if-present` and
  `npm run test --workspaces --if-present` pass locally; CI runs the same
  checks on every branch.
- Keep PRs scoped to one fix or feature. Unrelated cleanup makes review slower,
  not faster.
- If your change affects how closely the port matches upstream behavior,
  mention what you compared against (upstream source file/commit, or an
  observed upstream behavior) in the PR description.

## License

Battle for Wesnoth (and therefore this port, and any contribution to it) is
licensed under the GNU General Public License v2 or later — see
[COPYING](COPYING). By contributing, you agree your contribution is licensed
under the same terms.
