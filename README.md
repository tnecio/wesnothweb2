# wesnothweb2

Battle for Wesnoth, rewritten for the web.

Unlike the [wesnothweb](https://github.com/tnecio/wesnothweb) attempt (C++ engine
compiled to WASM, TypeScript UI on top), this project takes only the game
*assets* (WML scenario/unit/campaign data, images, audio, music) from the
original C++ codebase and reimplements the game's logic natively in
TypeScript, aimed squarely at the browser rather than porting a desktop
engine's dependencies (SDL, Boost, etc.) unchanged.

See [docs/](docs/) for the architecture and implementation plan, and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for CI, releases and deployment.

Play it at https://wesnoth.tnec.io.
