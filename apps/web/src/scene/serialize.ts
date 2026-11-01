import type { LayoutData } from './layout.ts';

/** props.json in the house style: one prop / area per line, so diffs stay readable. */
export function serializeLayout(d: LayoutData): string {
  const j = (v: unknown) => JSON.stringify(v).replace(/,(?=["[{\d-])/g, ', ').replace(/":/g, '": ');
  const nav = d.nav;
  const lines = [
    '{',
    `  "_note": ${JSON.stringify(d._note ?? '')},`,
    `  "room": ${j(d.room)},`,
    '  "nav": {',
    `    "_note": ${JSON.stringify(nav._note ?? '')},`,
    `    "cell": ${nav.cell ?? 12},`,
    '    "areas": [',
    nav.areas.map((a) => '      ' + j(a)).join(',\n'),
    '    ],',
    '    "blocks": [',
    nav.blocks.map((b) => '      ' + j(b)).join(',\n'),
    '    ],',
    `    "stairs": ${j(nav.stairs)}`,
    '  },',
    '  "props": [',
    d.props.map((p) => '    ' + j(p)).join(',\n'),
    '  ]',
    '}',
    '',
  ];
  return lines.filter((l) => l !== '').join('\n') + '\n';
}

export const round1 = (v: number) => Math.round(v * 10) / 10;
