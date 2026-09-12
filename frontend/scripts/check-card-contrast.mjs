import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const themeCss = readFileSync(
  fileURLToPath(new URL("../src/theme.css", import.meta.url)),
  "utf8"
);
const canvasCss = readFileSync(
  fileURLToPath(new URL("../src/routes/canvasPage.css", import.meta.url)),
  "utf8"
);

const STUDIO = ["avocado", "plum", "linen", "cement", "maple", "rust"];
const PANTRY = [
  "citrus",
  "strawberry",
  "chocolate",
  "floral",
  "blueberry",
  "ferment",
  "wine",
  "vanilla",
  "herb",
  "bay",
];
const NIGHT_GARDEN = [
  "flare",
  "sky",
  "orchid",
  "coral",
  "sprout",
  "navy",
  "mint",
  "aqua",
];

function declarations(css) {
  const values = new Map();
  for (const match of css.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    values.set(match[1], match[2].trim());
  }
  return values;
}

function selectorBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  if (!match) throw new Error(`Missing CSS block: ${selector}`);
  return declarations(match[1]);
}

const tokens = declarations(themeCss);

function resolveToken(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`Circular CSS token: --${name}`);
  const value = tokens.get(name);
  if (!value) throw new Error(`Missing CSS token: --${name}`);
  if (/^#[\da-f]{6}$/i.test(value)) return value;
  const reference = value.match(/^var\(--([\w-]+)\)$/);
  if (!reference) throw new Error(`Cannot resolve --${name}: ${value}`);
  return resolveToken(reference[1], new Set([...seen, name]));
}

function hexChannels(hex) {
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

function mix(first, second, amount) {
  const a = hexChannels(first);
  const b = hexChannels(second);
  const channels = a.map((channel, index) =>
    Math.round(channel * amount + b[index] * (1 - amount))
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex) {
  const channels = hexChannels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const failures = [];
function requireContrast(label, foreground, background, minimum) {
  const ratio = contrast(foreground, background);
  if (ratio < minimum) {
    failures.push(`${label}: ${ratio.toFixed(2)}:1 (requires ${minimum}:1)`);
  }
  return ratio;
}

const studioBlock = selectorBlock(canvasCss, ".canvas-appearance-studio");
const darkStudioBlock = selectorBlock(canvasCss, ".theme-dark .canvas-appearance-studio");
const nightBlock = selectorBlock(canvasCss, ".canvas-appearance-night_garden");
const lightTheme = selectorBlock(themeCss, ".theme-light");
const darkTheme = selectorBlock(themeCss, ".theme-dark");

function percentage(block, name) {
  const value = block.get(name);
  if (!value?.endsWith("%")) throw new Error(`Missing percentage token: --${name}`);
  return Number.parseFloat(value) / 100;
}

const studioLightStrength = percentage(studioBlock, "studio-fill-strength");
const studioDarkStrength = percentage(darkStudioBlock, "studio-fill-strength");
const nightStrength = percentage(nightBlock, "night-fill-strength");
const comfortableText = 6.75;

for (const hue of STUDIO) {
  const pigment = resolveToken(`palette-${hue}`);
  requireContrast(
    `Studio/Paper ${hue}`,
    lightTheme.get("study-text"),
    mix(pigment, lightTheme.get("study-bg-card"), studioLightStrength),
    comfortableText
  );
  requireContrast(
    `Studio/Ink ${hue}`,
    darkTheme.get("study-text"),
    mix(pigment, darkTheme.get("study-bg-card"), studioDarkStrength),
    comfortableText
  );
}

for (const hue of PANTRY) {
  requireContrast(
    `Pantry ${hue}`,
    resolveToken(`fill-ink-${hue}`),
    resolveToken(`palette-${hue}`),
    4.5
  );
}

for (const hue of NIGHT_GARDEN) {
  requireContrast(
    `Night Garden ${hue}`,
    resolveToken("night-text"),
    mix(resolveToken(`palette-${hue}`), resolveToken("night-bg-card"), nightStrength),
    comfortableText
  );
}

for (const hue of [...STUDIO, ...PANTRY, ...NIGHT_GARDEN]) {
  requireContrast(
    `Accent control ${hue}`,
    resolveToken(`hue-ink-${hue}`),
    resolveToken(`palette-${hue}`),
    3
  );
}

if (failures.length) {
  console.error(`Card contrast audit failed:\n${failures.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}

console.log(
  "Card contrast audit passed: calm themes >= 6.75:1, Pantry text >= 4.5:1, accents >= 3:1."
);
