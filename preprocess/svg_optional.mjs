import fs from 'node:fs/promises';
import path from 'node:path';

function collectHorizontalLines(edgeMask, width, height, rowStep, minRun, maxLines) {
  const lines = [];
  for (let y = 0; y < height && lines.length < maxLines; y += rowStep) {
    let x = 0;
    while (x < width && lines.length < maxLines) {
      while (x < width && edgeMask[y * width + x] === 0) {
        x += 1;
      }
      const start = x;
      while (x < width && edgeMask[y * width + x] > 0) {
        x += 1;
      }
      const end = x - 1;
      if (end - start + 1 >= minRun) {
        lines.push({ x1: start, y1: y, x2: end, y2: y });
      }
    }
  }
  return lines;
}

function collectVerticalLines(edgeMask, width, height, colStep, minRun, maxLines) {
  const lines = [];
  for (let x = 0; x < width && lines.length < maxLines; x += colStep) {
    let y = 0;
    while (y < height && lines.length < maxLines) {
      while (y < height && edgeMask[y * width + x] === 0) {
        y += 1;
      }
      const start = y;
      while (y < height && edgeMask[y * width + x] > 0) {
        y += 1;
      }
      const end = y - 1;
      if (end - start + 1 >= minRun) {
        lines.push({ x1: x, y1: start, x2: x, y2: end });
      }
    }
  }
  return lines;
}

function buildSvg(width, height, lines) {
  const strokeWidth = Math.max(1, Math.round(Math.min(width, height) / 360));
  const lineNodes = lines
    .map(
      (line) =>
        `<line x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}" stroke="#111" stroke-opacity="0.9" stroke-width="${strokeWidth}" stroke-linecap="round" />`,
    )
    .join('\n  ');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    '  <g fill="none">',
    `  ${lineNodes}`,
    '  </g>',
    '</svg>',
  ].join('\n');
}

export async function maybeGenerateOptionalSvg(edgeMask, width, height, options) {
  if (!options.enableSvg || !options.suggestedByModel) {
    return {
      applied: false,
      svgUrl: null,
      reason: options.enableSvg ? 'model did not recommend SVG for this input' : 'SVG disabled',
      lineCount: 0,
    };
  }

  const rowStep = Math.max(3, Math.floor(height / 160));
  const colStep = Math.max(3, Math.floor(width / 160));
  const minRun = Math.max(12, Math.floor(Math.min(width, height) / 28));
  const maxLines = 480;

  const horizontal = collectHorizontalLines(edgeMask, width, height, rowStep, minRun, maxLines);
  const vertical = collectVerticalLines(edgeMask, width, height, colStep, minRun, maxLines - horizontal.length);
  const lines = [...horizontal, ...vertical];

  if (lines.length === 0) {
    return {
      applied: false,
      svgUrl: null,
      reason: 'no stable line runs detected from edge mask',
      lineCount: 0,
    };
  }

  const svgText = buildSvg(width, height, lines);
  const svgPath = path.join(options.outputDir, 'structure.svg');
  await fs.writeFile(svgPath, svgText, 'utf8');

  return {
    applied: true,
    svgUrl: './structure.svg',
    reason: 'line-runs extracted from edge mask',
    lineCount: lines.length,
  };
}

