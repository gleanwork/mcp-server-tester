import React, { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  badge?: React.ReactNode;
}

export function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
  badge,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full text-left mb-2 group"
        aria-expanded={open}
        aria-controls={contentId}
      >
        {open ? (
          <ChevronDown
            aria-hidden="true"
            className="h-3 w-3 text-muted-foreground"
          />
        ) : (
          <ChevronRight
            aria-hidden="true"
            className="h-3 w-3 text-muted-foreground"
          />
        )}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground group-hover:text-foreground transition-colors">
          {title}
        </h3>
        {badge}
      </button>
      {open && <div id={contentId}>{children}</div>}
    </div>
  );
}
