import { theme } from 'antd';
import { THEME_PRESETS } from '@/features/platform/brandingApi';
import { describe, expect, it } from 'vitest';
import { normalizeAppearance, resolveAppearance, getAppearanceVariables, createAppearanceTheme, contrastRatio } from './appearance';

const DEFAULT_BLUE = '#0064c8';
function expectedPrimary(mode: 'dark' | 'light', accent: string) {
  return mode === 'dark' && accent === DEFAULT_BLUE ? '#339dff' : accent;
}

describe('appearance', () => {
  it('keeps every valid preference, defaults unknown ones to light, and only follows the OS in system mode', () => {
    expect(normalizeAppearance('dark')).toBe('dark');
    expect(normalizeAppearance('light')).toBe('light');
    expect(normalizeAppearance('system')).toBe('system');
    expect(normalizeAppearance(null)).toBe('light');
    expect(normalizeAppearance('broken')).toBe('light');
    expect(resolveAppearance('light', true)).toBe('light');
    expect(resolveAppearance('dark', false)).toBe('dark');
    expect(resolveAppearance('system', true)).toBe('dark');
    expect(resolveAppearance('system', false)).toBe('light');
  });
  it('keeps neutral surfaces and semantic colors independent of customer accent', () => {
    for (const mode of ['dark', 'light'] as const) {
      const orange = getAppearanceVariables(mode, '#f97316');
      const blue = getAppearanceVariables(mode, '#2563eb');
      for (const key of ['--aw-bg','--aw-panel','--aw-text','--aw-border','--aw-info','--aw-success','--aw-error','--aw-warning']) expect(orange[key]).toBe(blue[key]);
      expect(createAppearanceTheme(mode, '#f97316').token?.colorError).toBe(createAppearanceTheme(mode, '#2563eb').token?.colorError);
      for (const key of ['--aw-info','--aw-success-deep','--aw-error-deep']) expect(contrastRatio(orange[key], orange['--aw-panel'])).toBeGreaterThanOrEqual(4.5);
      // #967d00 is the prototype-fixed warn text grade: 4.0:1 on white, above the 3:1 large-text bar.
      expect(contrastRatio(orange['--aw-warning-deep'], orange['--aw-panel'])).toBeGreaterThanOrEqual(3.5);
      expect(orange['--aw-accent']).not.toBe(blue['--aw-accent']);
    }
  });
  it('keeps primary-button text readable for presets and extreme customer colors', () => {
    for (const mode of ['dark', 'light'] as const) for (const accent of ['#f97316','#2563eb','#059669','#4f46e5','#e11d48','#0891b2','#d97706','#7c3aed','#374151','#0f766e','#ffffff','#000000']) {
      const v = getAppearanceVariables(mode, accent);
      for (const key of ['--aw-primary','--aw-primary-hover','--aw-primary-active']) expect(contrastRatio(v[key], v['--aw-primary-ink'])).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('preserves every selected theme color for fills, links and highlights in both modes', () => {
    for (const mode of ['dark', 'light'] as const) for (const accent of [...THEME_PRESETS.map(p => p.primaryColor.toLowerCase()), '#ffffff', '#000000', '#809010']) {
      const variables = getAppearanceVariables(mode, accent);
      expect(variables['--aw-accent']).toBe(accent);
      const primary = expectedPrimary(mode, accent);
      for (const key of ['--aw-accent-text', '--aw-primary']) expect(variables[key]).toBe(primary);
      const config = createAppearanceTheme(mode, accent);
      const tokens = theme.getDesignToken(config);
      for (const value of [tokens.colorPrimary, tokens.colorLink]) expect(value).toBe(primary);
      // 原型 a:hover/.input:focus 走 primary-hover/active 阶梯而非平铺主色。
      expect(tokens.colorLinkHover).toBe(variables['--aw-primary-hover']);
      expect(tokens.colorLinkActive).toBe(variables['--aw-primary-active']);
      expect(config.components?.Button?.colorPrimary).toBe(primary);
      expect(config.components?.Checkbox?.colorPrimary).toBe(primary);
      expect(config.components?.Switch?.colorPrimary).toBe(primary);
      expect(config.components?.Radio?.buttonSolidCheckedBg).toBe(primary);
      expect(config.components?.Menu?.itemSelectedColor).toBe(primary);
    }
  });
  it('walks the fixed color ladder for the default blue preset instead of mix() derivation', () => {
    const light = getAppearanceVariables('light', DEFAULT_BLUE);
    expect(light['--aw-primary']).toBe('#0064c8');
    expect(light['--aw-primary-hover']).toBe('#0052a4');
    expect(light['--aw-primary-active']).toBe('#004385');
    expect(light['--aw-primary-weak']).toBe('#eff3f8');
    expect(light['--aw-primary-faint']).toBe('#f7f9fa');
    expect(light['--aw-primary-ink']).toBe('#ffffff');
    expect(createAppearanceTheme('light', DEFAULT_BLUE).token?.controlOutline).toBe('rgba(0,100,200,.12)');
    expect(createAppearanceTheme('dark', DEFAULT_BLUE).token?.controlOutline).toBe('rgba(51,157,255,.2)');
    const dark = getAppearanceVariables('dark', DEFAULT_BLUE);
    expect(dark['--aw-accent']).toBe(DEFAULT_BLUE);
    expect(dark['--aw-primary']).toBe('#339dff');
    expect(dark['--aw-primary-hover']).toBe('#5cadff');
    expect(dark['--aw-primary-active']).toBe('#2e8ff0');
    expect(dark['--aw-primary-ink']).toBe('#0d1620');
    for (const key of ['--aw-primary','--aw-primary-hover','--aw-primary-active']) expect(contrastRatio(dark[key], dark['--aw-primary-ink'])).toBeGreaterThanOrEqual(4.5);
  });
  it('applies the redesign density, radii and typography tokens globally', () => {
    for (const mode of ['dark', 'light'] as const) {
      const config = createAppearanceTheme(mode, '#f97316');
      expect(config.token?.fontSize).toBe(14);
      expect(config.token?.controlHeight).toBe(32);
      expect(config.token?.controlHeightSM).toBe(26);
      expect(config.token?.borderRadius).toBe(6);
      expect(config.token?.borderRadiusLG).toBe(8);
      expect(config.token?.borderRadiusSM).toBe(4);
      expect(config.token?.fontFamily).toContain('"Segoe UI"');
      expect(config.components?.Table).toMatchObject({ cellFontSize: 12, cellPaddingBlock: 10, cellPaddingInline: 12 });
      expect(config.components?.Menu).toMatchObject({ itemHeight: 32, itemBorderRadius: 6 });
      expect(config.components?.Card?.headerFontSize).toBe(14);
      expect(config.components?.Modal?.boxShadow).toBe('0 8px 24px rgba(0,0,0,.16)');
    }
  });
  it('exposes the XConsole light neutrals and the semantic color triads as CSS variables', () => {
    const light = getAppearanceVariables('light', '#f97316');
    expect(light['--aw-text']).toBe('#333333');
    expect(light['--aw-text-2']).toBe('#555555');
    expect(light['--aw-text-3']).toBe('#808080');
    expect(light['--aw-text-disabled']).toBe('#aaaaaa');
    expect(light['--aw-border']).toBe('#e5e5e5');
    expect(light['--aw-gray-bg']).toBe('#f6f6f6');
    expect(light['--aw-header-bg']).toBe('#fafafa');
    expect(light['--aw-error']).toBe('#e00000');
    expect(light['--aw-error-deep']).toBe('#b90000');
    expect(light['--aw-error-bg']).toBe('#ffeaea');
    expect(light['--aw-warning']).toBe('#ffd813');
    expect(light['--aw-warning-deep']).toBe('#967d00');
    expect(light['--aw-warning-bg']).toBe('#fff9d9');
    expect(light['--aw-success']).toBe('#009431');
    expect(light['--aw-success-deep']).toBe('#007a29');
    expect(light['--aw-success-bg']).toBe('#e4ffed');
    expect(light['--aw-ai']).toBe('#6a4cff');
    expect(light['--aw-ai-bg']).toBe('#f0ebff');
    expect(light['--aw-font-mono']).toContain('ui-monospace');
  });
  it('rejects malformed brand colors before using them in CSS', () => {
    expect(getAppearanceVariables('dark', 'url(x)')['--aw-accent']).toBe(DEFAULT_BLUE);
  });
});

it('keeps the prototype segmented colors independent of the accent', () => {
  for (const mode of ['dark', 'light'] as const) {
    const v = getAppearanceVariables(mode, '#2563eb');
    expect(createAppearanceTheme(mode, '#2563eb').components?.Segmented).toMatchObject({trackBg: v['--aw-gray-bg'], itemSelectedBg: v['--aw-panel'], itemSelectedColor: v['--aw-text']});
  }
});
