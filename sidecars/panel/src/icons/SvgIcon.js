/**
 * @fileoverview Dynamic SVG icon component and incremental icon patcher.
 */

import { SVG_ICON_DEFS } from './svgRegistry.js';

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function createSvgIcon(name, { size = 14, className = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (className) {
    svg.setAttribute('class', `svg-icon ${className}`.trim());
  } else {
    svg.setAttribute('class', 'svg-icon');
  }
  patchSvgIcon(svg, name);
  return svg;
}

export function patchSvgIcon(svgEl, name) {
  if (!svgEl || svgEl.dataset?.iconName === name) return false;
  if (svgEl.dataset) {
    svgEl.dataset.iconName = name;
  }
  while (svgEl.firstChild) {
    svgEl.removeChild(svgEl.firstChild);
  }
  const shapes = SVG_ICON_DEFS[name] || SVG_ICON_DEFS.dot;
  for (const shape of shapes) {
    const child = document.createElementNS(SVG_NS, shape.tag);
    for (const [k, v] of Object.entries(shape.attrs)) {
      child.setAttribute(k, v);
    }
    svgEl.appendChild(child);
  }
  return true;
}

let brandGradientSeq = 0;

function createSvgNode(tag, attrs, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  for (const child of children) {
    node.appendChild(child);
  }
  return node;
}

export function createBrandIcon({ size = 16, className = '' } = {}) {
  const id = ++brandGradientSeq;
  const maskId = `agy-brand-m-${id}`;
  const archId = `agy-brand-arch-${id}`;
  const baseId = `agy-brand-base-${id}`;
  const tailId = `agy-brand-tail-${id}`;
  const strokeAttrs = {
    'stroke-width': '9.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };
  const defs = createSvgNode('defs', {}, [
    createSvgNode('mask', { id: maskId }, [
      createSvgNode('path', {
        d: 'M16.3 59.9H24.2Q27.2 59.9 28.6 57.2L42.8 29Q44.5 25.6 46.2 29.1L65.9 70.5',
        stroke: '#fff',
        ...strokeAttrs,
      }),
    ]),
    createSvgNode(
      'linearGradient',
      { id: archId, x1: '28', y1: '49', x2: '59', y2: '41', gradientUnits: 'userSpaceOnUse' },
      [
        createSvgNode('stop', { offset: '0%', 'stop-color': '#3484fe' }),
        createSvgNode('stop', { offset: '18%', 'stop-color': '#32b2b6' }),
        createSvgNode('stop', { offset: '36%', 'stop-color': '#6cc367' }),
        createSvgNode('stop', { offset: '48%', 'stop-color': '#f2a236' }),
        createSvgNode('stop', { offset: '56%', 'stop-color': '#fb6e44' }),
        createSvgNode('stop', { offset: '72%', 'stop-color': '#b46fb2' }),
        createSvgNode('stop', { offset: '88%', 'stop-color': '#5d7ef1' }),
        createSvgNode('stop', { offset: '100%', 'stop-color': '#3584fd' }),
      ]
    ),
    createSvgNode(
      'linearGradient',
      { id: baseId, x1: '0', y1: '43', x2: '0', y2: '62', gradientUnits: 'userSpaceOnUse' },
      [
        createSvgNode('stop', { offset: '0%', 'stop-color': '#3484fe', 'stop-opacity': '0' }),
        createSvgNode('stop', { offset: '100%', 'stop-color': '#3484fe', 'stop-opacity': '1' }),
      ]
    ),
    createSvgNode(
      'linearGradient',
      { id: tailId, x1: '65.9', y1: '70.5', x2: '77', y2: '53.5', gradientUnits: 'userSpaceOnUse' },
      [
        createSvgNode('stop', { offset: '0%', 'stop-color': '#3a8dfd' }),
        createSvgNode('stop', { offset: '35%', 'stop-color': '#48a4fd' }),
        createSvgNode('stop', { offset: '72%', 'stop-color': '#56b4fe' }),
        createSvgNode('stop', { offset: '100%', 'stop-color': '#5dbbfd' }),
      ]
    ),
  ]);
  return createSvgNode(
    'svg',
    {
      viewBox: '6 6 88 88',
      width: size,
      height: size,
      fill: 'none',
      'aria-hidden': 'true',
      class: className ? `svg-icon agy-brand-icon ${className}` : 'svg-icon agy-brand-icon',
    },
    [
      defs,
      createSvgNode('g', { mask: `url(#${maskId})` }, [
        createSvgNode('rect', { x: '6', y: '6', width: '88', height: '88', fill: `url(#${archId})` }),
        createSvgNode('rect', { x: '6', y: '6', width: '88', height: '88', fill: `url(#${baseId})` }),
      ]),
      createSvgNode('path', {
        d: 'M65.9 70.5L73.2 56.8Q74.7 54.1 77.8 54.1H83.4',
        stroke: `url(#${tailId})`,
        ...strokeAttrs,
      }),
    ]
  );
}
