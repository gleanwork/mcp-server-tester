# MST brand assets

MST is short for MCP Server Tester. The mark is a check between square brackets, like a passing line of test output.

## Files

| File                | Use                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `mst-mark.svg`      | Light backgrounds. The default.                                                              |
| `mst-mark-dark.svg` | Dark backgrounds.                                                                            |
| `mst-mark-mono.svg` | One color. Uses `currentColor`: inlined, it takes the text color; as an `<img>`, it's black. |
| `favicon.svg`       | 24px and smaller. A separate drawing aligned to the pixel grid; follows the OS color mode.   |

For GitHub Markdown, let the viewer's color mode pick the file:

```html
<picture>
  <source
    media="(prefers-color-scheme: dark)"
    srcset="assets/brand/mst-mark-dark.svg"
  />
  <img src="assets/brand/mst-mark.svg" alt="MST logo" width="64" height="64" />
</picture>
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
- **Clear space:** leave at least a bracket's serif width (1/8 of the mark's size) on every side.
- **Don't** recolor the check green or amber: next to CI badges it reads as a build status.
- **Don't** put the brackets and check in the same color except in the one-color version.
- **Don't** stretch, rotate, outline, or add effects to the mark.

## Geometry

The mark is drawn on a 48-unit grid with 4.5-unit round strokes. The favicon is drawn on a 16-unit grid with 2-unit strokes, and the brackets land on whole pixels. Edit the SVG paths directly; there is no source file in another tool.
