# MST brand assets

MST is short for MCP Server Tester. The mark is a check between square brackets, like a passing line of test output.

## Files

| File                                                | Use                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `mst-mark.svg`                                      | Light backgrounds. The default.                                                              |
| `mst-mark-dark.svg`                                 | Dark backgrounds.                                                                            |
| `mst-mark-mono.svg`                                 | One color. Uses `currentColor`: inlined, it takes the text color; as an `<img>`, it's black. |
| `favicon.svg`                                       | 24px and smaller. A separate drawing aligned to the pixel grid; follows the OS color mode.   |
| `mst-mark-heading.svg`, `mst-mark-heading-dark.svg` | Inline in a Markdown heading only (see below).                                               |

The mark files are cropped to the artwork, with no built-in padding, so they line up with the text beside them.

### In a GitHub Markdown heading

Put the mark inline and let the viewer's color mode pick the file. The whole heading must stay on one line:

<!-- prettier-ignore -->
```markdown
# <picture><source media="(prefers-color-scheme: dark)" srcset="assets/brand/mst-mark-heading-dark.svg"><img src="assets/brand/mst-mark-heading.svg" alt="MST logo" height="34" align="absmiddle"></picture>&nbsp; MST (MCP Server Tester)
```

GitHub strips `style` attributes, so `align` is the only way to position the image, and `align="absmiddle"` centers it on lowercase-letter height. That leaves the regular mark about 3px low next to capitals in a 2em heading. The heading files fix this by adding empty space below the artwork (a `viewBox` height of 39.5 instead of 32.5), which lifts the mark to center on the capital letters. At `height="34"` the visible mark is 28px tall and extends about 2.7px above the capitals and below the baseline. `&nbsp;` plus a space gives about 14px between the mark and the title.

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
