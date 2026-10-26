import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import type { AiModel } from '../../../../shared/ai-models';

// No <form>: the picker lives inside the composer form, and React bubbles a
// portal's submit to it. Enter is handled on the input instead.
export function ModelSearchDialog({ open, title, models, selected, onSelect, onClose }: {
  open: boolean; title: string; models: AiModel[]; selected: string; onSelect(model: string): void; onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return models.filter(m => !m.disabled && terms.every(t => `${m.value} ${m.label}`.toLowerCase().includes(t)));
  }, [models, query]);
  useEffect(() => { if (open) { setQuery(''); setActive(0); } }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const choose = (value: string) => { onSelect(value); onClose(); };
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <DialogContent className="max-w-md gap-3">
      <DialogTitle>{title}</DialogTitle>
      <label className="flex items-center gap-2 rounded-md border border-input bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
        <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <input autoFocus value={query} aria-label="Search models" aria-controls="model-search-results" placeholder={`Search ${models.length} models`}
          aria-activedescendant={results[active] ? `model-option-${active}` : undefined}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => Math.min(i + 1, results.length - 1)); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
            else if (event.key === 'Enter') { event.preventDefault(); if (results[active]) choose(results[active].value); }
          }}
          className="w-full bg-transparent py-2 text-sm outline-none" />
      </label>
      {results.length ? <ul ref={list} id="model-search-results" role="listbox" aria-label="Models" className="max-h-80 overflow-y-auto">
        {results.map((model, index) => <li key={model.value} id={`model-option-${index}`} data-index={index} role="option" aria-selected={model.value === selected}
          onMouseEnter={() => setActive(index)} onClick={() => choose(model.value)}
          className={`flex cursor-default items-center justify-between gap-3 rounded-sm px-2 py-2 text-sm ${index === active ? 'bg-accent text-accent-foreground' : ''}`}>
          <span className="min-w-0 break-words">{model.label}</span>{model.value === selected && <Check size={14} aria-hidden="true" className="shrink-0" />}
        </li>)}
      </ul> : <p role="status" className="py-6 text-center text-sm text-muted-foreground">No models match “{query.trim()}”.</p>}
    </DialogContent>
  </Dialog>;
}
