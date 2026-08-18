# Pre-Cursive — text → handwriting PDF

Paste text, press one button, download a PDF set in the NTPreCursive handwriting face.

Everything runs in the visitor's browser. There is no server, no build step and no
external request at runtime — which is what makes it free to host forever.

## Run locally

Open `index.html` in a browser. That's it — the font is embedded as base64, so it
works straight from `file://` with no web server.

To serve it properly (any static server will do):

```bash
npx serve .
```

## Deploy to GitHub Pages (free, permanent)

```bash
git init && git add -A && git commit -m "Pre-Cursive converter"
git branch -M main
git remote add origin https://github.com/USERNAME/precursive.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Source: `main` / root**. The site is live at
`https://USERNAME.github.io/precursive/` in about a minute.

Cloudflare Pages works identically — point it at the repo, leave the build command
empty and set the output directory to `/`.

## Files

| Path | Purpose |
|---|---|
| `index.html` | Markup |
| `css/style.css` | Styling, light + dark themes |
| `js/engine.js` | TrueType parser, character folding, line breaking, kerning |
| `js/app.js` | UI wiring and PDF generation |
| `js/font-data.js` | The font, base64-encoded |
| `vendor/` | pdf-lib + fontkit (vendored, not from a CDN) |
| `NTPreCursive.ttf` | Original font file |

## Why there is a custom font parser

pdf-lib reads **GPOS** for kerning. NTPreCursive has no GPOS — it carries the older
`kern` table with 303 pairs. Left to pdf-lib, every pair renders unkerned; `Y.`
alone would sit 204 units too loose.

`engine.js` therefore parses the font itself and emits the PDF `TJ` operator with
the real kern values:

```
[<0001> -30 <00020003...>] TJ
```

The same parser also detects what the font genuinely supports.

## Known limits of this font (handled, not hidden)

Established by analysing the font directly:

- **165 codepoints mapped, but only 123 are usable.**
- **41 codepoints share one hollow-rectangle "tofu" outline** — `™ ® ¢ ¥ ¡ ¿ « » ¼ ½ ¾
  Œ œ ﬁ ﬂ Š š Ž ž Ł ł Ÿ µ ‰` and the spacing accents all render as an empty box.
- **There are no accented letters at all.** U+00C0–U+00FF is absent, so no
  é à ü ñ ç ö å æ ø ß.
- **U+0060 (backtick) is blank *and* zero-width.**

The app folds these before rendering (`café` → `cafe`, `™` → `(TM)`, `½` → `1/2`)
and reports every change in the UI. Anything genuinely unrenderable — Cyrillic, CJK,
emoji — becomes `?` and is listed by codepoint. It never fails silently.

## Font licence

The typeface is **© 2003 Thomas Nelson & Sons Limited**, designed by Labyrinth IT.
Its `fsType` is 0 ("Installable Embedding"), which permits embedding it into the
PDFs this tool generates.

Serving the `.ttf` from a public site is redistribution, which that flag does not by
itself grant. If that matters for your deployment, `js/font-data.js` is the only
place the font is bound in — swapping in a differently-licensed face is a one-file
change, and `engine.js` parses any TrueType font.
