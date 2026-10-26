import { cn } from '../lib/utils';
import { useMemo } from 'react';

// Robinhood-style rolling digits: when a formatted number changes — a live
// price tick or scrubbing the chart to another point — each digit slides
// vertically to its new value while punctuation stays put. Non-digit
// characters ($ , . % + - and letters) render statically.
// Positions are keyed from the right so the decimal places keep their reel
// identity as the integer part grows or shrinks (e.g. 99.98 -> 100.01).

function Reel({ digit }: { digit: number }): React.JSX.Element {
  return (
    <span
      className="inline-block overflow-hidden"
      style={{ height: '1em', lineHeight: '1em', verticalAlign: 'bottom' }}
      aria-hidden="true"
    >
      <span
        className="rolling-reel flex flex-col"
        style={{ transform: `translateY(-${digit}em)` }}
      >
        {Array.from({ length: 10 }, (_, value) => (
          <span key={value} className="text-center" style={{ height: '1em', lineHeight: '1em' }}>
            {value}
          </span>
        ))}
      </span>
    </span>
  );
}

export function RollingNumber({
  value,
  className,
}: {
  value: string;
  className?: string;
}): React.JSX.Element {
  const chars = useMemo(() => value.split(''), [value]);
  return (
    <span className={cn('inline-flex tabular-nums', className)} style={{ lineHeight: 1 }}>
      {/* A screen-reader-friendly copy of the whole value. */}
      <span className="sr-only">{value}</span>
      {chars.map((char, index) => {
        const keyFromRight = chars.length - index;
        if (/\d/u.test(char)) {
          return <Reel key={`d${keyFromRight}`} digit={Number(char)} />;
        }
        return (
          <span
            key={`s${keyFromRight}`}
            className="inline-block"
            style={{ height: '1em', lineHeight: '1em', verticalAlign: 'bottom' }}
            aria-hidden="true"
          >
            {char === ' ' ? ' ' : char}
          </span>
        );
      })}
    </span>
  );
}
