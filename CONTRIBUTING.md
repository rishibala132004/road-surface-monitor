# Contributing

This is a four-person course project with a hard deadline, so the process is light but not absent.

## Branches and pull requests

- `main` is always deployable: every push to it is published to GitHub Pages.
- Work on a branch named after the change (`feature/area-report`, `fix/owntracks-mapping`).
- Open a pull request, fill in the template, and ask one teammate to review. Small changes can be merged by the author after CI passes.
- Write commit messages as short imperative sentences ("Add GPS and condition time join").

## Before you push

```bash
npm run lint       # ESLint and Prettier
npm run typecheck  # TypeScript, strict mode
npm test           # Vitest unit tests
npm run build      # production build
```

`npm run format` fixes formatting. CI runs the same four commands.

## Where things live

- `src/data/` is the only place that knows about message formats. Change the contract there and in `docs/DATA_CONTRACT.md` together.
- `src/styles/tokens.css` holds every colour, font and spacing value. Components never hard-code colours.
- `public/config.json` holds the deployed defaults. Settings the user changes in the browser are merged on top.
- `publisher/` is the Raspberry Pi side (Python). It has no build step; keep it compatible with Python 3.10.

## Writing

British spelling, metric units, plain English. No emoji in code, comments or documentation.

## Credentials

Never commit broker URLs with passwords, `.env.local`, or exported settings files that contain a password. The dashboard keeps credentials in the browser only.
