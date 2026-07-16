// Small shared UI pieces, styles copied exactly from the prototype.

/** Circled-i info dot with an instant tooltip (data-tip). */
export function InfoDot({ tip, align }: { tip: string; align?: 'right' }) {
  return (
    <span
      data-tip={tip} data-tip-align={align}
      style={{
        width: 15,
        height: 15,
        borderRadius: '50%',
        border: '1px solid var(--fnt)',
        color: 'var(--fnt)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 600,
        cursor: 'help',
        flex: 'none',
      }}
    >
      i
    </span>
  );
}

/** 46×26 pill toggle with a 20px knob — the Settings dry-run / tags-required switch. */
export function ToggleSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      style={{
        position: 'relative',
        width: 46,
        height: 26,
        borderRadius: 99,
        border: 'none',
        cursor: 'pointer',
        background: on ? 'var(--acc)' : 'var(--bd)',
        transition: 'background .15s',
        padding: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,.25)',
          transition: 'left .15s',
          left: on ? 23 : 3,
        }}
      />
    </button>
  );
}

/**
 * Spinning ring (rrspin). Defaults to the wizard's 28px accent ring;
 * pass size 11 + colorVar 'var(--amT)' + trackVar 'var(--amD)' for the
 * inline "Posting" spinner.
 */
export function Spinner({
  size = 28,
  colorVar = 'var(--acc)',
  trackVar = 'var(--bd)',
}: {
  size?: number;
  colorVar?: string;
  trackVar?: string;
}) {
  const borderWidth = size >= 20 ? 3 : 2;
  return (
    <span
      style={{
        width: size,
        height: size,
        border: `${borderWidth}px solid ${trackVar}`,
        borderTopColor: colorVar,
        borderRadius: '50%',
        animation: 'rrspin .8s linear infinite',
        display: 'inline-block',
      }}
    />
  );
}
