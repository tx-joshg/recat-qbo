import { expect, it } from 'vitest';
import { installGlobalStyles } from '../test/globalStyles';

it('distinguishes enabled, disabled, custom, and passive interaction cursors', () => {
  const style = installGlobalStyles();
  try {
    document.body.innerHTML = `
      <main class="rr">
        <button id="enabled">Enabled</button>
        <button id="disabled" disabled>Disabled</button>
        <a id="aria-disabled-link" href="/unavailable" aria-disabled="true">Unavailable link</a>
        <div id="semantic" role="button">Semantic</div>
        <div id="aria-disabled" role="button" aria-disabled="true">Unavailable</div>
        <div id="surface" class="interactive-surface">Surface</div>
        <div id="passive">Passive</div>
      </main>
    `;

    const cursor = (id: string) => getComputedStyle(document.getElementById(id)!).cursor;
    expect(cursor('enabled')).toBe('pointer');
    expect(cursor('disabled')).toBe('not-allowed');
    expect(cursor('aria-disabled-link')).toBe('not-allowed');
    expect(cursor('semantic')).toBe('pointer');
    expect(cursor('aria-disabled')).toBe('not-allowed');
    expect(cursor('surface')).toBe('pointer');
    expect(cursor('passive')).not.toBe('pointer');
  } finally {
    style.remove();
    document.body.innerHTML = '';
  }
});

it('turns off control and descendant transitions for reduced motion', () => {
  const style = installGlobalStyles();
  try {
    const reducedMotion = Array.from(style.sheet!.cssRules).find(
      (rule): rule is CSSMediaRule =>
        rule instanceof CSSMediaRule && rule.conditionText === '(prefers-reduced-motion: reduce)',
    );
    const transitionRule = Array.from(reducedMotion!.cssRules).find(
      (rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule && rule.selectorText.includes('.interactive-surface'),
    );
    const sharedControlTransitionRule = Array.from(reducedMotion!.cssRules).find(
      (rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule && rule.selectorText.includes('.control-trigger') && rule.selectorText.includes(') *'),
    );

    expect(transitionRule).toBeDefined();
    expect(transitionRule!.selectorText).toContain(') *');
    expect(transitionRule!.style.getPropertyValue('transition')).toBe('none');
    expect(transitionRule!.style.getPropertyPriority('transition')).toBe('important');
    expect(sharedControlTransitionRule).toBeDefined();
    expect(sharedControlTransitionRule!.style.getPropertyValue('transition')).toBe('none');
    expect(sharedControlTransitionRule!.style.getPropertyPriority('transition')).toBe('important');
  } finally {
    style.remove();
  }
});

it('uses a not-allowed cursor for disabled shared control options', () => {
  const style = installGlobalStyles();
  try {
    document.body.innerHTML = '<main class="rr"><div id="disabled-option" class="control-option is-disabled">Unavailable</div></main>';

    expect(getComputedStyle(document.getElementById('disabled-option')!).cursor).toBe('not-allowed');
  } finally {
    style.remove();
    document.body.innerHTML = '';
  }
});
