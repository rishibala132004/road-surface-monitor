/**
 * Keyboard shortcuts and the help overlay listing them.
 */
import { el } from '../utils/dom';
import { Drawer } from './drawer';

export interface ShortcutActions {
  fullscreen(): void;
  theme(): void;
  pipeline(): void;
  overview(): void;
  playPause(): void;
  reset(): void;
  selectBike(index: number): void;
  help(): void;
  escape(): void;
}

export const SHORTCUTS: [string, string][] = [
  ['F', 'Full screen'],
  ['T', 'Switch theme'],
  ['P', 'System pipeline view'],
  ['O', 'Overview: fit the whole ride'],
  ['Space', 'Play or pause the replay or simulation'],
  ['R', 'Reset the ride'],
  ['1 to 4', 'Select a bike'],
  ['?', 'This list'],
  ['Esc', 'Close panels'],
];

export function installShortcuts(actions: ShortcutActions): void {
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const typing =
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);
    if (e.key === 'Escape') {
      actions.escape();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case 'f':
      case 'F':
        actions.fullscreen();
        break;
      case 't':
      case 'T':
        actions.theme();
        break;
      case 'p':
      case 'P':
        actions.pipeline();
        break;
      case 'o':
      case 'O':
        actions.overview();
        break;
      case ' ':
        e.preventDefault();
        actions.playPause();
        break;
      case 'r':
      case 'R':
        actions.reset();
        break;
      case '?':
        actions.help();
        break;
      case '1':
      case '2':
      case '3':
      case '4':
        actions.selectBike(Number(e.key) - 1);
        break;
      default:
        return;
    }
  });
}

export class HelpDrawer {
  readonly drawer: Drawer;

  constructor(host: HTMLElement, title: string, team: string[], course: string, repoUrl: string) {
    this.drawer = new Drawer(host, 'Shortcuts and about', 'drawer-help');
    const table = el('table', { class: 'shortcut-table' });
    for (const [key, what] of SHORTCUTS)
      table.append(
        el('tr', {}, [el('td', {}, [el('kbd', { text: key })]), el('td', { text: what })]),
      );
    this.drawer.body.append(
      el('section', { class: 'settings-section' }, [
        el('h3', { class: 't-label', text: 'Keyboard' }),
        table,
      ]),
      el('section', { class: 'settings-section' }, [
        el('h3', { class: 't-label', text: 'About' }),
        el('p', {
          text: `${title}: a live dashboard for a bicycle-mounted road surface classifier. A Thingy:52 streams IMU data to a Raspberry Pi 5, which runs a model trained in Edge Impulse and publishes one label per window over MQTT. A phone supplies GPS.`,
        }),
        el('p', { text: `Team: ${team.join(', ')}. ${course}.` }),
        el('p', {}, [
          el('a', { href: repoUrl, target: '_blank', rel: 'noopener', text: 'Source code' }),
        ]),
        el('p', {
          class: 'field-hint',
          text: 'Map data from OpenStreetMap contributors, map styles by CARTO, street names from Nominatim.',
        }),
      ]),
    );
  }
}
