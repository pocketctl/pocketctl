// Bundled with the pinned Mermaid Tiny distribution by build.mjs.
mermaid.startOnLoad = false;

const maxTextSize = 12000;
const maxEdges = 160;
const maxNodes = 100;
const maxGroups = 16;
const prefix = 'pocket-diagram-' + Math.random().toString(36).slice(2) + '-';
let nextId = 0;
let pending = Promise.resolve();

function checkSource(source) {
  if (typeof source !== 'string' || source.length > maxTextSize) {
    throw new Error('Diagram source is too large');
  }
  // Skip ordinary comment lines when identifying the diagram. Reject configuration
  // directives anywhere, including those preceding the diagram declaration.
  const code = source.replace(/^\s*%%[^\n]*$/gm, '').trimStart();
  if (!/^(?:graph|flowchart)\s+(?:TD|TB|BT|LR|RL)\b/.test(code)) {
    throw new Error('Unsupported diagram type');
  }
  // Extended metadata can request image assets. Limit markup to line breaks.
  const withoutBreaks = source.replace(/<br\s*\/?\s*>/gi, '');
  if (/%%\s*\{|@\s*\{|<\/?[a-z][\w:-]*[\s/>]|!\[|(?:^|[;\n])\s*(?:click|style|classDef|linkStyle)\s/i.test(withoutBreaks)) {
    throw new Error('Diagram contains unsupported formatting or interaction');
  }
}

function checkGraph(db) {
  const vertices = db.getVertices();
  const edges = db.getEdges();
  const groups = db.getSubGraphs();
  if (vertices.size > maxNodes || edges.length > maxEdges || groups.length > maxGroups) {
    throw new Error('Diagram is too complex');
  }
  if (db.getClasses().size || edges.defaultStyle || edges.defaultInterpolate ||
      [...vertices.values()].some(node => node.img || node.icon || node.link ||
        node.haveCallback || node.styles.length || node.classes.length) ||
      edges.some(edge => edge.style?.length || edge.classes.length || edge.animate) ||
      groups.some(group => group.classes?.length)) {
    throw new Error('Diagram contains unsupported formatting or interaction');
  }
}

function staticSvg(markup) {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.localName !== 'svg' || doc.querySelector('foreignObject, image, a, script, use, animate, set, iframe')) {
    throw new Error('Expected a static SVG flowchart');
  }
  for (const element of doc.querySelectorAll('*')) {
    for (const attr of element.attributes) {
      if (/^on/i.test(attr.name) || attr.localName === 'href') {
        throw new Error('Unexpected interactive SVG attribute');
      }
    }
  }
  const [, , width, height] = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
    throw new Error('Invalid SVG dimensions');
  }
  if (Math.max(width, height) > 16384 || width * height > 32000000) {
    throw new Error('Diagram dimensions exceed the image limit');
  }
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.removeAttribute('style');
  return { svg: new XMLSerializer().serializeToString(svg), width, height };
}

async function draw(source, dark) {
  checkSource(source);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize,
    maxEdges,
    layout: 'dagre',
    theme: dark ? 'dark' : 'default',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    flowchart: { htmlLabels: false, useMaxWidth: false },
  });
  const parsed = await mermaid.mermaidAPI.getDiagramFromText(source);
  checkGraph(parsed.db);
  // Mermaid measures SVG text in the document. display:none would produce zero bounds.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  try {
    const { svg } = await mermaid.render(prefix + (++nextId), source, host);
    return staticSvg(svg);
  } finally {
    host.remove();
  }
}

// Mermaid reuses parser and theme state. Serialize a full initialize/parse/render cycle.
window.PocketDiagram = Object.freeze({
  render(source, dark) {
    const result = pending.then(() => draw(source, dark));
    pending = result.catch(() => {});
    return result;
  },
});
