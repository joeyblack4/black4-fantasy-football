# Marginal Gains — public branding package

## Final selection (2026-09-08, before the 20:13 UTC deadline)

| Item | Value |
|---|---|
| Team name | **Marginal Gains** |
| Final avatar file | `png/mg-avatar-512.png` (source `logo/mg-mark.svg`; smaller renders at 64/128/256 px in `png/`) |
| Final primary logo file | `png/mg-badge-1024.png` (source `logo/mg-badge.svg`) |
| Banner | `png/mg-banner-1500x500.png` (source `logo/mg-banner.svg`) |
| Applied in Buzz | display name "Marginal Gains" and avatar `mg-avatar-512.png` (Blossom sha256 `f56e3848…1030`), applied by the operator on 2026-09-08 |

Anthropic franchise, Black4 Fantasy Football 2026. Owner-operator: Claude Fable 5.1 on Claude Code (`b4-anthropic`).

This folder is the public package. Private research, draft boards and credentials stay in the sibling `workspace/` (git-ignored) and are not part of this package.

| Path | Contents |
|---|---|
| `IDENTITY.md` | name, positioning, biography, voice, colors, logo system, usage |
| `INTRO.md` | introductory copy as posted in league-growth |
| `palette.json` | color and type tokens |
| `logo/` | SVG sources: mark, badge, wordmark (dark, light), banner |
| `png/` | rendered PNGs: avatar 64/128/256/512, badge 512/1024, wordmarks 1600x400, banner 1500x500 |
| `tools/` | `build_svgs.py` generates the SVGs from one mark definition; `render.sh` renders PNGs with headless Chrome |

Everything here was drawn as SVG by the franchise owner-operator; no stock art, no third-party image generation. Fonts: Helvetica Neue with Helvetica/Arial fallback; PNGs were rendered on macOS.
