// Traviora's SVG icons, self-hosted (no icon font, no third-party requests).
// Shapes are from Lucide (https://lucide.dev), v0.460.0, used under the ISC License:
//
//   Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
//   All other copyright (c) for Lucide are held by Lucide Contributors 2022.
//   Permission to use, copy, modify, and/or distribute this software for any purpose with or
//   without fee is hereby granted, provided that the above copyright notice and this permission
//   notice appear in all copies.
//
// Icons are built with createElementNS (no innerHTML) and are decorative by default
// (aria-hidden), so every icon must sit next to visible text that says the same thing.

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  'arrow-down': [['path',{'d':'M12 5v14'}],['path',{'d':'m19 12-7 7-7-7'}]],
  'arrow-up': [['path',{'d':'m5 12 7-7 7 7'}],['path',{'d':'M12 19V5'}]],
  'bed-double': [['path',{'d':'M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8'}],['path',{'d':'M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4'}],['path',{'d':'M12 4v6'}],['path',{'d':'M2 18h20'}]],
  'binoculars': [['path',{'d':'M10 10h4'}],['path',{'d':'M19 7V4a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v3'}],['path',{'d':'M20 21a2 2 0 0 0 2-2v-3.851c0-1.39-2-2.962-2-4.829V8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v11a2 2 0 0 0 2 2z'}],['path',{'d':'M 22 16 L 2 16'}],['path',{'d':'M4 21a2 2 0 0 1-2-2v-3.851c0-1.39 2-2.962 2-4.829V8a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2z'}],['path',{'d':'M9 7V4a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v3'}]],
  'book-open': [['path',{'d':'M12 7v14'}],['path',{'d':'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z'}]],
  'bus': [['path',{'d':'M8 6v6'}],['path',{'d':'M15 6v6'}],['path',{'d':'M2 12h19.6'}],['path',{'d':'M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3'}],['circle',{'cx':'7','cy':'18','r':'2'}],['path',{'d':'M9 18h5'}],['circle',{'cx':'16','cy':'18','r':'2'}]],
  'calendar-days': [['path',{'d':'M8 2v4'}],['path',{'d':'M16 2v4'}],['rect',{'width':'18','height':'18','x':'3','y':'4','rx':'2'}],['path',{'d':'M3 10h18'}],['path',{'d':'M8 14h.01'}],['path',{'d':'M12 14h.01'}],['path',{'d':'M16 14h.01'}],['path',{'d':'M8 18h.01'}],['path',{'d':'M12 18h.01'}],['path',{'d':'M16 18h.01'}]],
  'check': [['path',{'d':'M20 6 9 17l-5-5'}]],
  'circle-alert': [['circle',{'cx':'12','cy':'12','r':'10'}],['line',{'x1':'12','x2':'12','y1':'8','y2':'12'}],['line',{'x1':'12','x2':'12.01','y1':'16','y2':'16'}]],
  'clock': [['circle',{'cx':'12','cy':'12','r':'10'}],['polyline',{'points':'12 6 12 12 16 14'}]],
  'compass': [['path',{'d':'m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z'}],['circle',{'cx':'12','cy':'12','r':'10'}]],
  'indian-rupee': [['path',{'d':'M6 3h12'}],['path',{'d':'M6 8h12'}],['path',{'d':'m6 13 8.5 8'}],['path',{'d':'M6 13h3'}],['path',{'d':'M9 13c6.667 0 6.667-10 0-10'}]],
  'info': [['circle',{'cx':'12','cy':'12','r':'10'}],['path',{'d':'M12 16v-4'}],['path',{'d':'M12 8h.01'}]],
  'landmark': [['line',{'x1':'3','x2':'21','y1':'22','y2':'22'}],['line',{'x1':'6','x2':'6','y1':'18','y2':'11'}],['line',{'x1':'10','x2':'10','y1':'18','y2':'11'}],['line',{'x1':'14','x2':'14','y1':'18','y2':'11'}],['line',{'x1':'18','x2':'18','y1':'18','y2':'11'}],['polygon',{'points':'12 2 20 7 4 7'}]],
  'leaf': [['path',{'d':'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z'}],['path',{'d':'M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12'}]],
  'map': [['path',{'d':'M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z'}],['path',{'d':'M15 5.764v15'}],['path',{'d':'M9 3.236v15'}]],
  'map-pin': [['path',{'d':'M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0'}],['circle',{'cx':'12','cy':'10','r':'3'}]],
  'mountain': [['path',{'d':'m8 3 4 8 5-5 5 15H2L8 3z'}]],
  'rotate-ccw': [['path',{'d':'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'}],['path',{'d':'M3 3v5h5'}]],
  'scroll-text': [['path',{'d':'M15 12h-5'}],['path',{'d':'M15 8h-5'}],['path',{'d':'M19 17V5a2 2 0 0 0-2-2H4'}],['path',{'d':'M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3'}]],
  'square-pen': [['path',{'d':'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7'}],['path',{'d':'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z'}]],
  'users': [['path',{'d':'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'}],['circle',{'cx':'9','cy':'7','r':'4'}],['path',{'d':'M22 21v-2a4 4 0 0 0-3-3.87'}],['path',{'d':'M16 3.13a4 4 0 0 1 0 7.75'}]],
  'utensils': [['path',{'d':'M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2'}],['path',{'d':'M7 2v20'}],['path',{'d':'M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7'}]],
  'wallet': [['path',{'d':'M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1'}],['path',{'d':'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4'}]],
  'x': [['path',{'d':'M18 6 6 18'}],['path',{'d':'m6 6 12 12'}]],
};

/** Returns an <svg> element for a known icon name. Unknown names return an empty icon. */
export function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className);
  for (const [tag, attrs] of ICONS[name] || []) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

/** Replaces every <span data-icon="name"> placeholder in the page with the real icon. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.replaceWith(icon(el.dataset.icon, ['icon', el.className].filter(Boolean).join(' ')));
  });
}

export const ICON_NAMES = Object.keys(ICONS);
