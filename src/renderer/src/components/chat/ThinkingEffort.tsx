import { Menu } from '@base-ui/react/menu';
import { useId } from 'react';
import type { ReasoningEffort } from '../../../../shared/ai-models';

const labels: Record<ReasoningEffort, string> = {
  none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
};

// Stops are only the model's levels. With no level chosen the model uses its own
// default: the thumb rests there when the provider names it, and is hidden otherwise.
export function ThinkingEffort({ levels, value, defaultValue, disabled, onChange }: {
  levels: ReasoningEffort[]; value?: ReasoningEffort; defaultValue?: ReasoningEffort; disabled: boolean;
  onChange: (value: ReasoningEffort) => void;
}) {
  const id = useId();
  const shown = value ?? defaultValue;
  const index = shown ? levels.indexOf(shown) : -1;
  const label = value ? labels[value] : defaultValue ? `${labels[defaultValue]} (default)` : 'Model default';
  const position = (i: number) => levels.length > 1 ? i / (levels.length - 1) * 100 : 50;
  return <div className="mt-1 shrink-0 border-t border-border px-3 pt-3 pb-2" data-testid="thinking-effort">
    <div className="mb-2 flex items-center justify-between gap-2 text-xs">
      <label htmlFor={id} className="font-medium">Thinking effort</label>
      <span className="text-muted-foreground" aria-hidden="true">{label}</span>
    </div>
    <div className="relative h-6 rounded-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-popover">
      <div className="pointer-events-none absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 bg-border" aria-hidden="true">
        {levels.map((level, i) => <span key={level} style={{ left: `${position(i)}%` }}
          className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${i === index ? 'size-3.5 border-2 border-popover bg-foreground ring-1 ring-foreground' : 'size-1.5 border border-muted-foreground/40 bg-popover'}`} />)}
      </div>
      <Menu.Item id={id} role="slider" label="Thinking effort" closeOnClick={false} disabled={disabled}
        render={<input type="range" min={0} max={levels.length - 1} step={1} value={Math.max(0, index)}
          onChange={event => onChange(levels[Number(event.target.value)])} />}
        aria-valuetext={label} aria-describedby={value ? undefined : `${id}-help`}
        onKeyDown={event => {
          if (event.key === 'Escape' || event.key === 'Tab') return;
          event.stopPropagation(); event.preventBaseUIHandler();
          // A hidden thumb sits before the first stop, so the first step lands on a level.
          if (index < 0 && ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
            event.preventDefault(); onChange(levels[event.key === 'End' ? levels.length - 1 : 0]);
          }
        }}
        className="absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default" />
    </div>
    <div className="mt-1 flex justify-between text-[10px] text-muted-foreground" aria-hidden="true">
      {levels.map((level, i) => <span key={level} className={i === index ? 'text-foreground' : ''}>{labels[level]}</span>)}
    </div>
    {!value && <p id={`${id}-help`} className="mt-2 text-[11px] leading-4 text-muted-foreground">Uses the model’s default until you choose a level.</p>}
  </div>;
}
