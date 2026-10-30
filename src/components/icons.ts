/**
 * Inline SVG icons (stroke-based, 24 unit grid). Kept tiny and consistent.
 */
const wrap = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  follow: wrap('<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
  overview: wrap('<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M9 3v18"/>'),
  north: wrap('<path d="M12 3l5 16-5-3-5 3z"/>'),
  heading: wrap('<path d="M12 3l5 16-5-3-5 3z"/><path d="M4 4h4" stroke-width="2.4"/>'),
  reset: wrap('<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/>'),
  grid: wrap('<path d="M3 8h18M3 16h18M8 3v18M16 3v18"/>'),
  hex: wrap(
    '<path d="M12 2l8.7 5v10L12 22l-8.7-5V7z"/><path d="M12 2v20M3.3 7l17.4 10M20.7 7L3.3 17" opacity=".5"/>',
  ),
  plus: wrap('<path d="M12 5v14M5 12h14"/>'),
  minus: wrap('<path d="M5 12h14"/>'),
  sun: wrap(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  ),
  moon: wrap('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  settings: wrap(
    '<path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h10M18 17h2"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="17" r="2"/>',
  ),
  present: wrap('<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/>'),
  pipeline: wrap(
    '<circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="20" cy="12" r="2"/><path d="M6 12h4M14 12h4"/>',
  ),
  link: wrap(
    '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 6.8"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>',
  ),
  help: wrap(
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7"/><path d="M12 17h.01"/>',
  ),
  download: wrap('<path d="M12 3v12M7 10l5 5 5-5M4 19h16"/>'),
  close: wrap('<path d="M6 6l12 12M18 6L6 18"/>'),
  signal: wrap('<path d="M3 14l3-6 3 9 3-12 3 9 3-6 3 6"/>'),
  bike: wrap(
    '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-8h5l3 8M10 8l5 8M14 5h3"/>',
  ),
  camera: wrap('<path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
};

export type IconName = keyof typeof icons;
