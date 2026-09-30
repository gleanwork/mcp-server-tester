# MST brand assets

MST is short for MCP Server Tester. The mark is a check between square brackets, like a passing line of test output.

## Files

| File                | Use                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `mst-mark.svg`      | Light backgrounds. The default.                                                              |
| `mst-mark-dark.svg` | Dark backgrounds.                                                                            |
| `mst-mark-mono.svg` | One color. Uses `currentColor`: inlined, it takes the text color; as an `<img>`, it's black. |
| `favicon.svg`       | 24px and smaller. A separate drawing aligned to the pixel grid; follows the OS color mode.   |

The mark files are cropped to the artwork, with no built-in padding, so they line up with the text beside them.

For a GitHub Markdown heading, put the mark inline and let the viewer's color mode pick the file. It must stay on one line. `height="28"` with `align="absmiddle"` makes the brackets the same height as parentheses in a 2em heading. GitHub strips `style` attributes, so `align` is the only way to position it.

<!-- prettier-ignore -->
```markdown
# <picture><source media="(prefers-color-scheme: dark)" srcset="assets/brand/mst-mark-dark.svg"><img src="assets/brand/mst-mark.svg" alt="MST logo" height="28" align="absmiddle"></picture> MST (MCP Server Tester)
```

## Colors

| Role               | Light background | Dark background |
| ------------------ | ---------------- | --------------- |
| Check (Glean blue) | `#343CED`        | `#7C83FF`       |
| Brackets           | `#11141A`        | `#FFFFFF`       |

Glean blue `#343CED` has a contrast ratio of only 2.7:1 against GitHub's dark background (`#0D1117`), below the 3:1 minimum for graphics. Use `#7C83FF` (5.9:1) on dark backgrounds. On white, `#343CED` is 7.0:1.

## Usage

- **Name:** write "MST (MCP Server Tester)" on first mention. "MST" alone is also MobX-State-Tree.
- **CLI:** the command is `mst`; the npm package is `@gleanwork/mcp-server-tester`.
- **Size:** use `favicon.svg` at 24px and below, and the full mark above that.
- **Clear space:** the files have no padding. Leave at least a bracket's serif width (about 1/6 of the mark's width) on every side, except beside text on the same line, where a normal space is enough.
- **Don't** recolor the check green or amber: next to CI badges it reads as a build status.
- **Don't** put the brackets and check in the same color except in the one-color version.
- **Don't** stretch, rotate, outline, or add effects to the mark.

## Geometry

The mark is drawn on a 48-unit grid with 4.5-unit round strokes, and its `viewBox` (`5.75 7.75 36.5 32.5`) is cropped to the outer edge of the strokes. The favicon is drawn on a 16-unit grid with 2-unit strokes, and the brackets land on whole pixels. Edit the SVG paths directly; there is no source file in another tool.
