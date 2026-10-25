# wesnothweb2

Battle for Wesnoth, rewritten for the web.

This is an **unofficial, fan-made port** of
[Battle for Wesnoth](https://www.wesnoth.org/), a free/libre open-source
strategy game. It is not affiliated with or endorsed by the official Wesnoth
project. All game content (scenarios, units, campaigns, art, audio, music) is
taken verbatim from upstream Wesnoth, licensed under the GPLv2+ (see
[COPYING](COPYING)).

Unlike the [wesnothweb](https://github.com/tnecio/wesnothweb) attempt (C++ engine
compiled to WASM, TypeScript UI on top), this project takes only the game
*assets* (WML scenario/unit/campaign data, images, audio, music) from the
original C++ codebase and reimplements the game's logic natively in
TypeScript, aimed squarely at the browser rather than porting a desktop
engine's dependencies (SDL, Boost, etc.) unchanged.

See [docs/](docs/) for the architecture and implementation plan, and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for CI, releases and deployment.

Play it at https://wesnoth.fun.

## Contributing

Patches and bug fixes specific to this port, its UI, or that make it more
faithful to upstream's behavior are welcome. Game data, assets, and new
gameplay features should go to [upstream Wesnoth](https://github.com/wesnoth/wesnoth)
first. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.
