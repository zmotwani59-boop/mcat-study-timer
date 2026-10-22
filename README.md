# GUMAPS Website

Website for Georgetown University Minority Association of Pre-Health Students (GUMAPS).

## Site files
All live website files are in `gumaps/`:
- `index.html` — homepage
- `volunteer.html` — volunteer opportunities
- `research-fair.html` — Undergraduate Research Opportunities Fair directory (November 4, 2026)
- `research-fair-print.html` — print-friendly fair guide
- `research-qr.svg` — fair QR graphic

## Deployment
This is a clean, website-only branch prepared for a standalone GitHub repository. The existing GUMAPS Render service was previously configured to deploy from the `gumaps-site` branch of the original repository. Do not switch it until the standalone repository is populated.

For a Render Static Site deploying this structure, publish the `gumaps` directory. No Clockify, MCAT timer, Zahra HQ backend, or Vercel configuration is needed.

## Editing
Website updates are changes to the HTML and SVG files in `gumaps/`. Review changes before publishing to the live site.
