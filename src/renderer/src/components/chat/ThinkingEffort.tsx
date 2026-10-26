import { Menu } from '@base-ui/react/menu';
import { useId } from 'react';
import type { ReasoningEffort } from '../../../../shared/ai-models';

const labels: Record<ReasoningEffort, string> = {
  none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
};

export function ThinkingEffort({ levels, value, disabled, onChange }: {
  levels: ReasoningEffort[]; value?: ReasoningEffort; disabled: boolean;
  onChange: (value?: ReasoningEffort) => void;
}) {
  const id = useId();
  const stops = [undefined, ...levels];
  const index = Math.max(0, stops.indexOf(value));
  const label = index ? labels[stops[index]!] : 'Default';
  return <div className="mt-1 shrink-0 border-t border-border px-3 pt-3 pb-2" data-testid="thinking-effort">
    <div className="mb-2 flex items-center justify-between gap-2 text-xs">
      <label htmlFor={id} className="font-medium">Thinking effort</label>
      <span className="text-muted-foreground" aria-hidden="true">{label}</span>
    </div>
    <div className="relative h-6 rounded-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-popover">
      <div className="pointer-events-none absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 bg-border" aria-hidden="true">
        {stops.map((stop, i) => <span key={stop ?? 'default'} style={{ left: `${i / levels.length * 100}%` }}
          className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${i === index ? 'size-3.5 border-2 border-popover bg-foreground ring-1 ring-foreground' : 'size-1.5 border border-muted-foreground/40 bg-popover'}`} />)}
      </div>
      <Menu.Item id={id} role="slider" label="Thinking effort" closeOnClick={false} disabled={disabled}
        render={<input type="range" min={0} max={levels.length} step={1} value={index}
          onChange={event => onChange(stops[Number(event.target.value)])} />}
        aria-valuetext={label} aria-describedby={`${id}-help`}
        onKeyDown={event => { if (event.key !== 'Escape' && event.key !== 'Tab') { event.stopPropagation(); event.preventBaseUIHandler(); } }}
        className="absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default" />
    </div>
    <div className="mt-1 flex justify-between text-[10px] text-muted-foreground" aria-hidden="true">
      {stops.map((stop, i) => <span key={stop ?? 'default'} className={i === index ? 'text-foreground' : ''}>{stop ? labels[stop] : 'Default'}</span>)}
    </div>
    <p id={`${id}-help`} className="mt-2 text-[11px] leading-4 text-muted-foreground">
      {index === 0 ? 'Uses the model’s default effort.' : 'Higher effort can take longer and use more tokens.'}
    </p>
  </div>;
}
