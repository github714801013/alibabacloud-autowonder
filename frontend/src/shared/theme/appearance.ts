import { theme, type ThemeConfig } from 'antd';

export type AppearanceMode = 'dark' | 'light' | 'system';
export type ResolvedAppearance = Exclude<AppearanceMode, 'system'>;
export const APPEARANCE_KEY = 'autowonder.appearance';
export const DEFAULT_APPEARANCE = 'light' as const;
export function normalizeAppearance(value: unknown): AppearanceMode {
  return value === 'dark' || value === 'light' || value === 'system' ? value : DEFAULT_APPEARANCE;
}
export function resolveAppearance(mode: AppearanceMode, systemDark: boolean): ResolvedAppearance {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}
function rgb(hex: string) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
function luminance(hex: string) {
  const c = rgb(hex).map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
export function contrastRatio(a: string, b: string) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
function mix(hex: string, target: string, amount: number) {
  const end = rgb(target);
  return '#' + rgb(hex).map((v, i) => Math.round(v * (1 - amount) + end[i] * amount).toString(16).padStart(2, '0')).join('');
}
export const FONT_FAMILY = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif';
export const FONT_FAMILY_MONO = 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono","Courier New",monospace';
// The redesign default preset walks a fixed ladder instead of mix() derivation, so both modes stay on-spec.
const DEFAULT_ACCENT = '#0064c8';
export function getAppearanceVariables(mode: ResolvedAppearance, color: string): Record<string, string> {
  const dark = mode === 'dark';
  const accent = /^#[\da-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_ACCENT;
  const isDefaultBlue = accent === DEFAULT_ACCENT;
  const panel = dark ? '#1b2329' : '#ffffff';
  // Preserve the chosen brand color in both modes; adapt foreground ink, not the fill.
  const darkInk = contrastRatio(accent, '#171e23') >= 4.5 ? '#171e23' : '#000000';
  const ink = dark && isDefaultBlue ? '#0d1620'
    : contrastRatio(accent, '#ffffff') >= contrastRatio(accent, darkInk) ? '#ffffff' : darkInk;
  const away = ink === '#ffffff' ? '#000000' : '#ffffff';
  const primary = dark && isDefaultBlue ? '#339dff' : accent;
  const primaryHover = isDefaultBlue ? (dark ? '#5cadff' : '#0052a4') : mix(primary, away, .07);
  const primaryActive = isDefaultBlue ? (dark ? '#2e8ff0' : '#004385') : mix(primary, away, .14);
  const accentRgb = rgb(accent).join(',');
  const primaryWeak = isDefaultBlue ? (dark ? 'rgba(51,157,255,.14)' : '#eff3f8') : `rgba(${accentRgb},.13)`;
  const primaryFaint = isDefaultBlue ? (dark ? 'rgba(51,157,255,.08)' : '#f7f9fa') : `rgba(${accentRgb},.07)`;
  const accentText = primary;
  return {
    '--aw-accent': accent, '--aw-accent-rgb': accentRgb, '--aw-accent-text': accentText,
    '--aw-primary': primary, '--aw-primary-hover': primaryHover, '--aw-primary-active': primaryActive, '--aw-primary-ink': ink,
    '--aw-primary-weak': primaryWeak, '--aw-primary-faint': primaryFaint,
    '--aw-bg': dark ? '#171e23' : '#f6f6f6', '--aw-panel': panel, '--aw-sidebar': dark ? '#222a31' : '#ffffff',
    '--aw-raised': dark ? '#263039' : '#fafafa', '--aw-field': dark ? '#1a232a' : '#ffffff',
    '--aw-border': dark ? '#34404a' : '#e5e5e5', '--aw-text': dark ? '#f1f3f5' : '#333333', '--aw-muted': dark ? '#b9c4ce' : '#555555',
    '--aw-text-2': dark ? '#b9c4ce' : '#555555', '--aw-text-3': dark ? '#8d99a6' : '#808080', '--aw-text-disabled': dark ? '#5d6a76' : '#aaaaaa',
    '--aw-gray-bg': dark ? '#263039' : '#f6f6f6', '--aw-canvas': dark ? '#171e23' : '#f6f6f6', '--aw-header-bg': dark ? '#263039' : '#fafafa',
    '--aw-button': dark ? '#28323b' : '#ffffff', '--aw-button-hover': dark ? '#34414c' : '#ffffff', '--aw-button-active': dark ? '#202a32' : '#ffffff',
    '--aw-info': dark ? '#8cbcff' : '#175bc0',
    '--aw-error': dark ? '#ff938f' : '#e00000', '--aw-error-deep': dark ? '#ffb0ad' : '#b90000', '--aw-error-bg': dark ? 'rgba(255,147,143,.14)' : '#ffeaea',
    '--aw-warning': dark ? '#f5cc58' : '#ffd813', '--aw-warning-deep': dark ? '#ffdd6e' : '#967d00', '--aw-warning-bg': dark ? 'rgba(245,204,88,.14)' : '#fff9d9',
    '--aw-success': dark ? '#49d8a2' : '#009431', '--aw-success-deep': dark ? '#7fe0bc' : '#007a29', '--aw-success-bg': dark ? 'rgba(73,216,162,.14)' : '#e4ffed',
    '--aw-ai': dark ? '#9d8cff' : '#6a4cff', '--aw-ai-bg': dark ? 'rgba(157,140,255,.16)' : '#f0ebff',
    '--aw-link': primary,
    '--aw-font-mono': FONT_FAMILY_MONO,
    '--aw-shadow-card': '0 1px 2px rgba(0,0,0,.04)', '--aw-shadow-menu': '0 4px 8px rgba(0,0,0,.16)', '--aw-shadow-modal': '0 8px 24px rgba(0,0,0,.16)',
    '--aw-glass': dark ? 'rgba(32,43,53,.88)' : 'rgba(246,250,255,.88)',
  };
}
export function createAppearanceTheme(mode: ResolvedAppearance, accent: string): ThemeConfig {
  const v = getAppearanceVariables(mode, accent);
  const dark = mode === 'dark';
  return {
    algorithm: (seed, map) => ({
      ...(mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm)(seed, map),
      colorPrimary: v['--aw-accent-text'], colorPrimaryHover: v['--aw-accent-text'], colorPrimaryActive: v['--aw-accent-text'],
      colorLink: v['--aw-accent-text'], colorLinkHover: v['--aw-primary-hover'], colorLinkActive: v['--aw-primary-active'],
    }),
    token: {
      // Keep popup lifecycle independent of OS motion settings and runtime toggles.
      motion: false,
      colorPrimary: v['--aw-accent-text'], colorLink: v['--aw-accent-text'], colorLinkHover: v['--aw-primary-hover'], colorLinkActive: v['--aw-primary-active'], colorBgBase: v['--aw-bg'], colorBgLayout: v['--aw-bg'],
      // 原型 .input:focus 聚焦环：0 0 0 2px rgba(primary,.12)（暗色用暗档 primary 的 .2）。
      controlOutline: dark ? `rgba(${rgb(v['--aw-primary']).join(',')},.2)` : `rgba(${v['--aw-accent-rgb']},.12)`,
      colorBgContainer: v['--aw-panel'], colorBgElevated: v['--aw-panel'], colorText: v['--aw-text'], colorTextSecondary: v['--aw-text-2'], colorTextTertiary: v['--aw-text-3'], colorTextDisabled: v['--aw-text-disabled'],
      colorBorder: v['--aw-border'], colorBorderSecondary: v['--aw-border'], colorFillAlter: v['--aw-gray-bg'],
      colorError: dark ? '#ff827e' : '#e00000', colorSuccess: dark ? '#49d8a2' : '#009431',
      colorWarning: dark ? '#f5cc58' : '#967d00', colorWarningBg: dark ? '#2c2618' : '#fff9d9', colorWarningBorder: dark ? '#554628' : '#ead58a',
      borderRadius: 6, borderRadiusLG: 8, borderRadiusSM: 4, controlHeight: 32, controlHeightSM: 26, fontSize: 14,
      fontFamily: FONT_FAMILY,
    },
    components: {
      Input: { colorBgContainer: v['--aw-field'], hoverBg: v['--aw-field'], activeBg: v['--aw-field'] },
      Segmented: { trackBg: v['--aw-gray-bg'], itemSelectedBg: v['--aw-panel'], itemSelectedColor: v['--aw-text'], itemHoverBg: 'transparent', itemHoverColor: v['--aw-text'] },
      Button: { primaryColor: v['--aw-primary-ink'], colorPrimary: v['--aw-primary'], colorPrimaryHover: v['--aw-primary-hover'], colorPrimaryActive: v['--aw-primary-active'], primaryShadow: 'none', dangerShadow: 'none', defaultShadow: 'none', defaultBg: v['--aw-button'], defaultHoverBg: v['--aw-button-hover'], defaultActiveBg: v['--aw-button-active'], defaultColor: v['--aw-text'], defaultHoverColor: v['--aw-accent-text'], defaultActiveColor: v['--aw-primary-active'], defaultBorderColor: v['--aw-border'], defaultHoverBorderColor: v['--aw-primary'], defaultActiveBorderColor: v['--aw-primary-active'] },
      Layout: { headerBg: v['--aw-sidebar'], siderBg: v['--aw-sidebar'], bodyBg: v['--aw-bg'] },
      Table: { headerBg: v['--aw-header-bg'], headerColor: v['--aw-text-2'], rowHoverBg: v['--aw-gray-bg'], cellFontSize: 12, cellPaddingBlock: 10, cellPaddingInline: 12 },
      Menu: { itemBg: 'transparent', subMenuItemBg: 'transparent', itemSelectedBg: v['--aw-primary-weak'], itemSelectedColor: v['--aw-accent-text'], itemHoverBg: v['--aw-primary-faint'], itemHeight: 32, itemBorderRadius: 6, groupTitleFontSize: 13, groupTitleColor: v['--aw-accent-text'] },
      Card: { headerFontSize: 14, headerFontSizeSM: 13 },
      Checkbox: { colorPrimary: v['--aw-primary'], colorPrimaryHover: v['--aw-primary-hover'], colorWhite: v['--aw-primary-ink'] },
      Switch: { colorPrimary: v['--aw-primary'], colorPrimaryHover: v['--aw-primary-hover'], colorTextLightSolid: v['--aw-primary-ink'] },
      Radio: { buttonSolidCheckedBg: v['--aw-primary'], buttonSolidCheckedHoverBg: v['--aw-primary-hover'], buttonSolidCheckedActiveBg: v['--aw-primary-active'], buttonSolidCheckedColor: v['--aw-primary-ink'] },
      Select: { selectorBg: v['--aw-field'], optionSelectedBg: v['--aw-primary-weak'] },
      Tabs: { itemColor: v['--aw-text-2'], itemHoverColor: v['--aw-text'], itemSelectedColor: v['--aw-accent-text'], horizontalItemGutter: 4, horizontalItemPadding: '8px 12px' },
      // 原型 11 模式 B 表单字阶：标签 12/text-2、行距 16（labelFontSize/itemMarginBottom 无 CSS 覆盖路径，走 token）
      Form: { labelFontSize: 12, labelColor: v['--aw-text-2'], itemMarginBottom: 16 },
      Modal: { boxShadow: v['--aw-shadow-modal'] },
      Tooltip: { fontSize: 12 },
    },
  };
}
