// Cartoony inline-SVG chess pieces for Super Battle Chess.
// Every piece is a chunky outlined shape with a happy little face.

export const PALETTES = [
  { main: '#5aa6ff', dark: '#3a7de0', light: '#a8d2ff' }, // team 0 - blue
  { main: '#ff6b57', dark: '#d94a38', light: '#ffb3a0' }, // team 1 - red
  { main: '#62cd6e', dark: '#3da34c', light: '#aef0b4' }, // royale - green
  { main: '#b88af5', dark: '#9059d6', light: '#dcc4ff' }, // royale - purple
  { main: '#ffc94d', dark: '#dd9f1b', light: '#ffe6a8' }, // royale - gold items
];

const INK = '#2b2a40';
const GOLD = '#ffd34d';
const GOLD_DARK = '#e0a92e';

function face(cx, cy, s = 1) {
  return `<g stroke="none">
    <circle cx="${cx - 8.5 * s}" cy="${cy}" r="${5.4 * s}" fill="#fff" stroke="${INK}" stroke-width="${1.8 * s}"/>
    <circle cx="${cx + 8.5 * s}" cy="${cy}" r="${5.4 * s}" fill="#fff" stroke="${INK}" stroke-width="${1.8 * s}"/>
    <circle cx="${cx - 7.5 * s}" cy="${cy + 0.8 * s}" r="${2.6 * s}" fill="${INK}"/>
    <circle cx="${cx + 9.5 * s}" cy="${cy + 0.8 * s}" r="${2.6 * s}" fill="${INK}"/>
    <path d="M ${cx - 4.5 * s} ${cy + 8.5 * s} Q ${cx} ${cy + 12.5 * s} ${cx + 4.5 * s} ${cy + 8.5 * s}"
      stroke="${INK}" stroke-width="${2.6 * s}" fill="none" stroke-linecap="round"/>
  </g>`;
}

function shine(cx, cy, r) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff" opacity="0.45" stroke="none"/>`;
}

const BODIES = {
  pawn: (c) => `
    <ellipse cx="50" cy="89" rx="23" ry="7.5" fill="${c.dark}"/>
    <path d="M31 89 C31 66 39 58 50 58 C61 58 69 66 69 89 Z" fill="${c.main}"/>
    <circle cx="50" cy="39" r="20" fill="${c.main}"/>
    ${shine(42, 30, 4.5)}
    ${face(50, 38)}`,

  rook: (c) => `
    <ellipse cx="50" cy="90" rx="25" ry="7" fill="${c.dark}"/>
    <path d="M31 90 L31 25 L41 25 L41 33 L46 33 L46 25 L54 25 L54 33 L59 33 L59 25 L69 25 L69 90 Z"
      fill="${c.main}"/>
    <rect x="33" y="66" width="34" height="7" rx="3" fill="${c.dark}" opacity="0.55" stroke="none"/>
    ${shine(38, 34, 3.5)}
    ${face(50, 47)}`,

  knight: (c) => `
    <ellipse cx="52" cy="90" rx="24" ry="7" fill="${c.dark}"/>
    <path d="M34 90 C31 70 32 54 40 40 C44 30 52 22 61 23 L64 11 L72 24 C81 31 84 43 77 47 C72 50 65 50 61 47
             C58 52 57 57 59 63 C63 73 66 80 67 90 Z" fill="${c.main}"/>
    <path d="M61 23 L64 11 L72 24 C76 27 79 31 80 35 C74 28 67 24 61 23 Z" fill="${c.dark}" opacity="0.5" stroke="none"/>
    <circle cx="75" cy="40" r="2.4" fill="${INK}" stroke="none"/>
    <g stroke="none">
      <circle cx="59" cy="35" r="5.6" fill="#fff" stroke="${INK}" stroke-width="1.8"/>
      <circle cx="60.5" cy="35.8" r="2.7" fill="${INK}"/>
    </g>
    <path d="M48 56 Q52 60 50 66" stroke="${INK}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    ${shine(50, 30, 3.5)}`,

  bishop: (c) => `
    <ellipse cx="50" cy="90" rx="23" ry="7" fill="${c.dark}"/>
    <path d="M33 90 C33 74 39 68 50 68 C61 68 67 74 67 90 Z" fill="${c.main}"/>
    <path d="M50 17 C62 27 69 38 69 47 C69 59 61 68 50 68 C39 68 31 59 31 47 C31 38 38 27 50 17 Z"
      fill="${c.main}"/>
    <circle cx="50" cy="12" r="5.5" fill="${GOLD}" stroke="${GOLD_DARK}" stroke-width="2"/>
    <path d="M55 24 L63 35" stroke="${c.dark}" stroke-width="5" stroke-linecap="round"/>
    ${shine(42, 30, 3.5)}
    ${face(50, 46)}`,

  queen: (c) => `
    <ellipse cx="50" cy="90" rx="24" ry="7" fill="${c.dark}"/>
    <path d="M31 90 C31 67 38 59 50 59 C62 59 69 67 69 90 Z" fill="${c.main}"/>
    <circle cx="50" cy="43" r="19" fill="${c.main}"/>
    <path d="M33 32 L36 13 L45 24 L50 9 L55 24 L64 13 L67 32 Z"
      fill="${GOLD}" stroke="${GOLD_DARK}" stroke-width="2.5" stroke-linejoin="round"/>
    <g stroke="none">
      <circle cx="36" cy="12" r="3.2" fill="${GOLD}" stroke="${GOLD_DARK}" stroke-width="1.6"/>
      <circle cx="50" cy="8" r="3.2" fill="${GOLD}" stroke="${GOLD_DARK}" stroke-width="1.6"/>
      <circle cx="64" cy="12" r="3.2" fill="${GOLD}" stroke="${GOLD_DARK}" stroke-width="1.6"/>
    </g>
    ${shine(42, 38, 4)}
    ${face(50, 45)}`,

  king: (c) => `
    <ellipse cx="50" cy="90" rx="26" ry="7" fill="${c.dark}"/>
    <path d="M29 90 C29 66 37 57 50 57 C63 57 71 66 71 90 Z" fill="${c.main}"/>
    <circle cx="50" cy="42" r="20" fill="${c.main}"/>
    <path d="M33 31 L33 16 L42 22 L50 12 L58 22 L67 16 L67 31 Z"
      fill="${GOLD}" stroke="${GOLD_DARK}" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M50 1 L50 11 M45 5.5 L55 5.5" stroke="${GOLD_DARK}" stroke-width="3.6" stroke-linecap="round"/>
    ${shine(42, 37, 4)}
    ${face(50, 44)}`,
};

export function pieceSVG(type, team) {
  const c = PALETTES[team];
  return `<svg viewBox="-5 -5 110 110" xmlns="http://www.w3.org/2000/svg" class="piece-svg piece-${type}">
    <g stroke="${INK}" stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round" paint-order="stroke">
      ${BODIES[type](c)}
    </g>
  </svg>`;
}

export const PIECE_TYPES = Object.keys(BODIES);
