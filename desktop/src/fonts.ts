// Font imports (Vite ?url returns resolved asset URL)
import jetbrainsMonoLight from './fonts/jetbrains-mono-light.woff2?url';
import jetbrainsMonoRegular from './fonts/jetbrains-mono-regular.woff2?url';
import jetbrainsMonoBold from './fonts/jetbrains-mono-bold.woff2?url';

import firaCodeLight from './fonts/fira-code-light.woff2?url';
import firaCodeRegular from './fonts/fira-code-regular.woff2?url';
import firaCodeBold from './fonts/fira-code-bold.woff2?url';

import cascadiaCodeLight from './fonts/cascadia-code-light.woff2?url';
import cascadiaCodeRegular from './fonts/cascadia-code-regular.woff2?url';
import cascadiaCodeBold from './fonts/cascadia-code-bold.woff2?url';

import sourceCodeProLight from './fonts/source-code-pro-light.woff2?url';
import sourceCodeProRegular from './fonts/source-code-pro-regular.woff2?url';
import sourceCodeProBold from './fonts/source-code-pro-bold.woff2?url';

import hackRegular from './fonts/hack-regular.woff2?url';
import hackBold from './fonts/hack-bold.woff2?url';

import iosevkaLight from './fonts/iosevka-light.woff2?url';
import iosevkaRegular from './fonts/iosevka-regular.woff2?url';
import iosevkaBold from './fonts/iosevka-bold.woff2?url';

// Nerd Font icons come from one symbols-only font that every terminal font falls
// back to, instead of a patched "NF" copy of each font.
import symbolsNerdFontMono from './fonts/symbols-nerd-font-mono.woff2?url';

export interface FontDefinition {
  key: string;
  displayName: string;
  supportsLigatures: boolean;
  hasLightWeight: boolean;
  isSystem: boolean;
  cssFamily: string;
  files: {
    light: string;
    regular: string;
    bold: string;
  };
}

export const FONT_REGISTRY: FontDefinition[] = [
  {
    key: 'system-menlo',
    displayName: 'Menlo (System)',
    supportsLigatures: false,
    hasLightWeight: false,
    isSystem: true,
    cssFamily: 'Menlo, Monaco, "Courier New", monospace',
    files: { light: '', regular: '', bold: '' },
  },
  {
    key: 'system-monaco',
    displayName: 'Monaco (System)',
    supportsLigatures: false,
    hasLightWeight: false,
    isSystem: true,
    cssFamily: 'Monaco, Menlo, "Courier New", monospace',
    files: { light: '', regular: '', bold: '' },
  },
  {
    key: 'system-sf-mono',
    displayName: 'SF Mono (System)',
    supportsLigatures: false,
    hasLightWeight: true,
    isSystem: true,
    cssFamily: '"SF Mono", SFMono-Regular, Menlo, monospace',
    files: { light: '', regular: '', bold: '' },
  },
  {
    key: 'jetbrains-mono',
    displayName: 'JetBrains Mono',
    supportsLigatures: true,
    hasLightWeight: true,
    isSystem: false,
    cssFamily: '"JetBrains Mono", monospace',
    files: {
      light: jetbrainsMonoLight,
      regular: jetbrainsMonoRegular,
      bold: jetbrainsMonoBold,
    },
  },
  {
    key: 'fira-code',
    displayName: 'Fira Code',
    supportsLigatures: true,
    hasLightWeight: true,
    isSystem: false,
    cssFamily: '"Fira Code", monospace',
    files: {
      light: firaCodeLight,
      regular: firaCodeRegular,
      bold: firaCodeBold,
    },
  },
  {
    key: 'cascadia-code',
    displayName: 'Cascadia Code',
    supportsLigatures: true,
    hasLightWeight: true,
    isSystem: false,
    cssFamily: '"Cascadia Code", monospace',
    files: {
      light: cascadiaCodeLight,
      regular: cascadiaCodeRegular,
      bold: cascadiaCodeBold,
    },
  },
  {
    key: 'source-code-pro',
    displayName: 'Source Code Pro',
    supportsLigatures: false,
    hasLightWeight: true,
    isSystem: false,
    cssFamily: '"Source Code Pro", monospace',
    files: {
      light: sourceCodeProLight,
      regular: sourceCodeProRegular,
      bold: sourceCodeProBold,
    },
  },
  {
    key: 'hack',
    displayName: 'Hack',
    supportsLigatures: false,
    hasLightWeight: false,
    isSystem: false,
    cssFamily: '"Hack", monospace',
    files: {
      light: '',
      regular: hackRegular,
      bold: hackBold,
    },
  },
  {
    key: 'iosevka',
    displayName: 'Iosevka',
    supportsLigatures: true,
    hasLightWeight: true,
    isSystem: false,
    cssFamily: '"Iosevka", monospace',
    files: {
      light: iosevkaLight,
      regular: iosevkaRegular,
      bold: iosevkaBold,
    },
  },
];

const loadedFonts = new Set<string>();

/** Family name of the bundled symbols-only Nerd Font (see getFontFamily). */
const NERD_SYMBOLS_FAMILY = 'Symbols Nerd Font Mono';

async function loadNerdSymbols(): Promise<void> {
  if (loadedFonts.has(NERD_SYMBOLS_FAMILY)) return;
  loadedFonts.add(NERD_SYMBOLS_FAMILY);
  try {
    const face = await new FontFace(NERD_SYMBOLS_FAMILY, `url(${symbolsNerdFontMono})`).load();
    document.fonts.add(face);
  } catch (e) {
    console.warn('[font] FAILED to load Nerd Font symbols:', e);
  }
}

export async function loadFont(key: string, nerd: boolean, weight?: number): Promise<void> {
  if (nerd) await loadNerdSymbols();
  const def = FONT_REGISTRY.find((f) => f.key === key);
  if (!def || def.isSystem) return;

  const familyName = def.cssFamily.split(',')[0].replace(/"/g, '').trim();
  const regularUrl = def.files.regular;
  const boldUrl = def.files.bold;
  const lightUrl = def.files.light;

  const promises: Promise<FontFace>[] = [];

  // Always load regular (400) and bold (700)
  const regularKey = `${familyName}-400`;
  if (!loadedFonts.has(regularKey)) {
    const face = new FontFace(familyName, `url(${regularUrl})`, { weight: '400' });
    promises.push(face.load());
    loadedFonts.add(regularKey);
  }

  const boldKey = `${familyName}-700`;
  if (!loadedFonts.has(boldKey)) {
    const face = new FontFace(familyName, `url(${boldUrl})`, { weight: '700' });
    promises.push(face.load());
    loadedFonts.add(boldKey);
  }

  // Load light variant as a separate family name so Canvas API always picks it up.
  // WKWebView Canvas 2D may not reliably match FontFace weight=300 via the CSS
  // font shorthand, so we register light files under "<Family> Light" and switch
  // fontFamily in getFontFamily() when weight <= 300.
  if (def.hasLightWeight && lightUrl) {
    const lightFamily = `${familyName} Light`;
    const lightRegKey = `${lightFamily}-400`;
    if (!loadedFonts.has(lightRegKey)) {
      // Register as weight 400 of the "Light" family so canvas always hits it
      const face = new FontFace(lightFamily, `url(${lightUrl})`, { weight: '400' });
      promises.push(face.load());
      loadedFonts.add(lightRegKey);
    }
    // Also register the regular weight as bold(700) for the "Light" family,
    // so bold text in terminal still looks decent
    const lightBoldKey = `${lightFamily}-700`;
    if (!loadedFonts.has(lightBoldKey)) {
      const face = new FontFace(lightFamily, `url(${regularUrl})`, { weight: '700' });
      promises.push(face.load());
      loadedFonts.add(lightBoldKey);
    }
  }

  const results = await Promise.allSettled(promises);
  for (const r of results) {
    if (r.status === 'fulfilled') {
      document.fonts.add(r.value);
      console.log(`[font] loaded: "${r.value.family}" weight=${r.value.weight} status=${r.value.status}`);
    } else {
      console.warn(`[font] FAILED to load:`, r.reason);
    }
  }
  // Debug: list all registered font faces
  console.log(`[font] All registered faces:`, [...document.fonts].map(f => `${f.family}@${f.weight}`));
}

// ── UI (interface) font — independent of the terminal font ──────────────────
// A couple of system stacks (incl. a non-mono UI option) plus the bundled
// monospace fonts (reused from FONT_REGISTRY). Applied via the --ui-font CSS var.
export const UI_FONT_EXTRAS: { key: string; displayName: string; cssFamily: string }[] = [
  { key: 'ui-sans', displayName: 'System UI', cssFamily: '-apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif' },
  { key: 'ui-mono', displayName: 'System Mono', cssFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' },
];

function getUiFontStack(key: string): string {
  const extra = UI_FONT_EXTRAS.find((f) => f.key === key);
  if (extra) return extra.cssFamily;
  const reg = FONT_REGISTRY.find((f) => f.key === key);
  if (reg) {
    if (!reg.isSystem) void loadFont(key, false);
    return getFontFamily(key, false);
  }
  return UI_FONT_EXTRAS[1].cssFamily; // fallback: system mono
}

/** Apply the UI/interface font — sets the --ui-font CSS var that the whole UI inherits. */
export function applyUiFont(key: string): void {
  document.documentElement.style.setProperty('--ui-font', getUiFontStack(key));
}

export function getFontFamily(key: string, nerd: boolean, weight?: number, cjkKey?: string): string {
  const def = FONT_REGISTRY.find((f) => f.key === key);
  const base = def ? def.cssFamily : 'Menlo, Monaco, "Courier New", monospace';

  let family: string;
  // For bundled fonts: switch to the "Light" family when weight <= 300
  // For system fonts: keep original family (system provides light variant natively)
  if (def && weight !== undefined && weight <= 300 && def.hasLightWeight && !def.isSystem) {
    const baseName = base.split(',')[0].replace(/"/g, '').trim();
    family = `"${baseName} Light", ${base}`;
  } else {
    family = base;
  }

  // Nerd Font icons live in the Private Use Area, which none of the text fonts
  // cover, so the browser falls through to the symbols font for exactly those.
  if (nerd) family = insertBeforeGenericFallback(family, `"${NERD_SYMBOLS_FAMILY}"`);

  // Append CJK font before the generic fallback (monospace) so Chinese/Japanese/Korean
  // characters use the user-chosen CJK font instead of the system default.
  if (cjkKey) {
    const cjkDef = CJK_FONT_REGISTRY.find((f) => f.key === cjkKey);
    if (cjkDef) family = insertBeforeGenericFallback(family, cjkDef.cssFamily);
  }

  return family;
}

/** Insert `entry` before the trailing generic "monospace" fallback, if any. */
function insertBeforeGenericFallback(family: string, entry: string): string {
  const parts = family.split(',').map((s) => s.trim());
  if (parts[parts.length - 1] === 'monospace') {
    parts.splice(parts.length - 1, 0, entry);
  } else {
    parts.push(entry);
  }
  return parts.join(', ');
}

/**
 * Returns the effective fontWeight for xterm.js.
 * For bundled (non-system) fonts with a Light variant: return 400 when weight <= 300,
 * because we switch to the "<Family> Light" family instead.
 * For system fonts (e.g. SF Mono): pass the raw weight through — macOS provides
 * multiple weight files natively and Canvas can match them directly.
 */
export function getEffectiveFontWeight(key: string, weight: number): number {
  const def = FONT_REGISTRY.find((f) => f.key === key);
  if (def?.hasLightWeight && !def.isSystem && weight <= 300) return 400;
  return weight;
}

export function getFontDef(key: string): FontDefinition | undefined {
  return FONT_REGISTRY.find((f) => f.key === key);
}

// ---------------------------------------------------------------------------
// CJK (Chinese/Japanese/Korean) font support
// ---------------------------------------------------------------------------

export interface CJKFontDefinition {
  key: string;
  displayName: string;
  cssFamily: string;
  /** Platform hint: 'windows' | 'mac' | 'linux' | 'all' */
  platform: string;
}

/**
 * Common CJK fonts across platforms.
 * The list is intentionally broad — at runtime we detect which ones are
 * actually installed and only show those in the settings UI.
 */
export const CJK_FONT_REGISTRY: CJKFontDefinition[] = [
  // Windows
  { key: 'microsoft-yahei', displayName: '微软雅黑 (Microsoft YaHei)', cssFamily: '"Microsoft YaHei"', platform: 'windows' },
  { key: 'simhei', displayName: '黑体 (SimHei)', cssFamily: 'SimHei', platform: 'windows' },
  { key: 'simsun', displayName: '宋体 (SimSun)', cssFamily: 'SimSun', platform: 'windows' },
  { key: 'nsimsun', displayName: '新宋体 (NSimSun)', cssFamily: 'NSimSun', platform: 'windows' },
  { key: 'kaiti', displayName: '楷体 (KaiTi)', cssFamily: 'KaiTi', platform: 'windows' },
  { key: 'fangsong', displayName: '仿宋 (FangSong)', cssFamily: 'FangSong', platform: 'windows' },
  { key: 'dengxian', displayName: '等线 (DengXian)', cssFamily: 'DengXian', platform: 'windows' },
  // macOS
  { key: 'pingfang-sc', displayName: '苹方-简 (PingFang SC)', cssFamily: '"PingFang SC"', platform: 'mac' },
  { key: 'pingfang-tc', displayName: '苹方-繁 (PingFang TC)', cssFamily: '"PingFang TC"', platform: 'mac' },
  { key: 'hiragino-sans-gb', displayName: '冬青黑体 (Hiragino Sans GB)', cssFamily: '"Hiragino Sans GB"', platform: 'mac' },
  { key: 'stheiti', displayName: '华文黑体 (STHeiti)', cssFamily: 'STHeiti', platform: 'mac' },
  { key: 'stsong', displayName: '华文宋体 (STSong)', cssFamily: 'STSong', platform: 'mac' },
  { key: 'stkaiti', displayName: '华文楷体 (STKaiti)', cssFamily: 'STKaiti', platform: 'mac' },
  // Linux
  { key: 'noto-sans-cjk-sc', displayName: 'Noto Sans CJK SC', cssFamily: '"Noto Sans CJK SC"', platform: 'linux' },
  { key: 'noto-serif-cjk-sc', displayName: 'Noto Serif CJK SC', cssFamily: '"Noto Serif CJK SC"', platform: 'linux' },
  { key: 'wenquanyi-micro-hei', displayName: '文泉驿微米黑', cssFamily: '"WenQuanYi Micro Hei"', platform: 'linux' },
  { key: 'wenquanyi-zen-hei', displayName: '文泉驿正黑', cssFamily: '"WenQuanYi Zen Hei"', platform: 'linux' },
  // Cross-platform (bundled with some apps or manually installed)
  { key: 'sarasa-mono-sc', displayName: '更纱黑体 (Sarasa Mono SC)', cssFamily: '"Sarasa Mono SC"', platform: 'all' },
  { key: 'sarasa-gothic-sc', displayName: '更纱黑体 Gothic (Sarasa Gothic SC)', cssFamily: '"Sarasa Gothic SC"', platform: 'all' },
  { key: 'source-han-sans-sc', displayName: '思源黑体 (Source Han Sans SC)', cssFamily: '"Source Han Sans SC"', platform: 'all' },
  { key: 'source-han-serif-sc', displayName: '思源宋体 (Source Han Serif SC)', cssFamily: '"Source Han Serif SC"', platform: 'all' },
];

/**
 * Detect whether a font is available on the system using the classic
 * three-baseline canvas measurement technique.
 *
 * We measure a CJK test string against three generic families (monospace,
 * serif, sans-serif). If the target font matches ALL three baselines it's
 * almost certainly not installed (the browser fell through to the same
 * fallback). If it differs from ANY baseline, the font is present.
 *
 * This avoids the single-baseline pitfall where macOS monospace already
 * includes CJK glyphs, making "PingFang SC, monospace" look identical to
 * plain "monospace".
 */
function isFontAvailable(fontFamily: string): boolean {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  const testStr = '中文字体ABCgq';
  const size = '72px';
  const baselines = ['monospace', 'serif', 'sans-serif'] as const;

  for (const base of baselines) {
    ctx.font = `${size} ${base}`;
    const baseWidth = ctx.measureText(testStr).width;

    ctx.font = `${size} ${fontFamily}, ${base}`;
    const testWidth = ctx.measureText(testStr).width;

    if (Math.abs(testWidth - baseWidth) > 0.5) {
      return true;
    }
  }
  return false;
}

let _cachedAvailableCJKFonts: CJKFontDefinition[] | null = null;

/**
 * Returns CJK fonts that are actually installed on the current system.
 * Results are cached after the first call.
 */
export function getAvailableCJKFonts(): CJKFontDefinition[] {
  if (_cachedAvailableCJKFonts !== null) return _cachedAvailableCJKFonts;

  _cachedAvailableCJKFonts = CJK_FONT_REGISTRY.filter((f) => isFontAvailable(f.cssFamily));
  console.log(
    `[font] CJK fonts detected: ${_cachedAvailableCJKFonts.map((f) => f.displayName).join(', ') || '(none)'}`,
  );
  return _cachedAvailableCJKFonts;
}

/**
 * Look up a CJK font definition by key.
 */
export function getCJKFontDef(key: string): CJKFontDefinition | undefined {
  return CJK_FONT_REGISTRY.find((f) => f.key === key);
}
