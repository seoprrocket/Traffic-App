// "Your car on the map": original top-down car shapes (no real makes or logos), drawn pointing up.
export const CAR_COLORS = [
  ['#f4f5f7', 'White'], ['#16181d', 'Black'], ['#9aa3ad', 'Silver'], ['#c8102e', 'Red'],
  ['#1d4ed8', 'Blue'], ['#f2b705', 'Yellow'], ['#16794a', 'Green'], ['#e8641b', 'Orange'],
];

// Each style: body path + glass + details, in a 40×80 box. `c` = paint, `g` = glass, `d` = dark trim.
const STYLES = {
  'ev-suv': {
    label: 'Electric SUV', hint: 'Smooth, tall, all-glass roof',
    svg: (c, g, d) => `
      <path d="M8 10 Q8 3 20 2 Q32 3 32 10 L33 66 Q33 77 20 78 Q7 77 7 66 Z" fill="${c}" stroke="${d}" stroke-width="1.2"/>
      <path d="M10.5 17 Q20 12 29.5 17 L29 60 Q20 64 11 60 Z" fill="${g}"/>
      <path d="M12 21 L28 21" stroke="${d}" stroke-width=".8" opacity=".5"/>
      <rect x="5.2" y="20" width="2.4" height="5" rx="1" fill="${d}"/><rect x="32.4" y="20" width="2.4" height="5" rx="1" fill="${d}"/>
      <path d="M11 4.5 Q20 2.8 29 4.5" stroke="#fff" stroke-width="1.6" fill="none" opacity=".9"/>
      <path d="M10 75 L30 75" stroke="#ff3b3b" stroke-width="1.8"/>`,
  },
  supercar: {
    label: 'Supercar', hint: 'Low, wide wedge with a rear wing',
    svg: (c, g, d) => `
      <path d="M20 1 L29 8 L35 30 L36 62 L33 76 L7 76 L4 62 L5 30 L11 8 Z" fill="${c}" stroke="${d}" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M14 24 L26 24 L28 40 L12 40 Z" fill="${g}"/>
      <path d="M12.5 44 L27.5 44 L26.5 58 L13.5 58 Z" fill="${d}" opacity=".55"/>
      <path d="M5.5 46 L9 40 L9 54 Z" fill="${d}"/><path d="M34.5 46 L31 40 L31 54 Z" fill="${d}"/>
      <rect x="6" y="70" width="28" height="4" rx="1" fill="${d}"/>
      <path d="M13 9 L17 7 M27 9 L23 7" stroke="#fff" stroke-width="1.6"/>`,
  },
  'lux-suv': {
    label: 'Luxury SUV', hint: 'Tall and boxy with roof rails',
    svg: (c, g, d) => `
      <rect x="6" y="3" width="28" height="74" rx="5" fill="${c}" stroke="${d}" stroke-width="1.2"/>
      <rect x="9.5" y="15" width="21" height="13" rx="2" fill="${g}"/>
      <rect x="10" y="30" width="20" height="30" rx="1.5" fill="${c}" stroke="${d}" stroke-width=".6" opacity=".95"/>
      <path d="M9 31 L9 62 M31 31 L31 62" stroke="${d}" stroke-width="1.6"/>
      <rect x="10" y="63" width="20" height="8" rx="1.5" fill="${g}"/>
      <rect x="3.6" y="16" width="2.6" height="5" rx="1" fill="${d}"/><rect x="33.8" y="16" width="2.6" height="5" rx="1" fill="${d}"/>
      <path d="M9 5.5 L15 5.5 M25 5.5 L31 5.5" stroke="#fff" stroke-width="1.8"/>
      <path d="M9 75 L14 75 M26 75 L31 75" stroke="#ff3b3b" stroke-width="1.8"/>`,
  },
  sports: {
    label: 'Sports coupe', hint: 'Round nose and sloping fastback',
    svg: (c, g, d) => `
      <path d="M20 2 Q31 2 32 14 L33 50 Q34 70 26 77 L14 77 Q6 70 7 50 L8 14 Q9 2 20 2 Z" fill="${c}" stroke="${d}" stroke-width="1.2"/>
      <path d="M12 26 Q20 21 28 26 L27 38 L13 38 Z" fill="${g}"/>
      <path d="M13 42 L27 42 Q26 58 20 62 Q14 58 13 42 Z" fill="${g}" opacity=".85"/>
      <circle cx="12" cy="8" r="2.4" fill="#fff"/><circle cx="28" cy="8" r="2.4" fill="#fff"/>
      <rect x="5.4" y="27" width="2.4" height="4.5" rx="1" fill="${d}"/><rect x="32.2" y="27" width="2.4" height="4.5" rx="1" fill="${d}"/>
      <path d="M12 74 L28 74" stroke="#ff3b3b" stroke-width="1.6"/>`,
  },
};
export const CAR_STYLES = [['dot', 'Blue dot', 'The classic location dot'], ...Object.entries(STYLES).map(([k, v]) => [k, v.label, v.hint])];

/** SVG markup for a car style and paint color (pointing up). */
export function carSvg(style, color = '#f4f5f7', size = 40) {
  const s = STYLES[style]; if (!s) return '';
  const dark = '#1b1f27';
  const glass = '#2b3a4f';
  const outline = color === '#16181d' ? '#5b6472' : dark;
  return `<svg viewBox="0 0 40 80" width="${size / 2}" height="${size}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <ellipse cx="20" cy="42" rx="17" ry="38" fill="rgba(0,0,0,.28)"/>${s.svg(color, glass, outline)}</svg>`;
}
