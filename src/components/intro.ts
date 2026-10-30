/**
 * Opening sequence: the title appears, then the camera flies from a
 * city-wide view down onto the bike. Skippable with a click or any key,
 * never delays data (the simulation is already running underneath), and
 * reduced to an instant start with reduced motion.
 */
import { el } from '../utils/dom';

export function playIntro(
  host: HTMLElement,
  title: string,
  subtitle: string,
  motion: number,
  flight: (done: () => void) => void,
): Promise<void> {
  return new Promise((resolve) => {
    if (motion === 0) {
      flight(() => resolve());
      return;
    }
    const overlay = el('div', { class: 'intro motion' }, [
      el('div', { class: 'intro-card' }, [
        el('div', { class: 'intro-kicker t-label', text: 'Live road surface dashboard' }),
        el('h1', { class: 'intro-title t-display', text: title }),
        el('p', { class: 'intro-sub', text: subtitle }),
        el('p', { class: 'intro-skip t-label', text: 'Click or press any key to skip' }),
      ]),
    ]);
    host.append(overlay);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      overlay.classList.add('is-out');
      window.removeEventListener('keydown', finish);
      setTimeout(() => overlay.remove(), 700);
      flight(() => resolve());
    };
    overlay.addEventListener('click', finish);
    window.addEventListener('keydown', finish);
    requestAnimationFrame(() => overlay.classList.add('is-in'));
    setTimeout(finish, 2600);
  });
}
