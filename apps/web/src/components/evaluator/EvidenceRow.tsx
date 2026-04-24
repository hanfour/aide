"use client";

// Evidence quotes for a single rubric section, shown when a row is expanded.

export interface EvidenceItem {
  requestId?: string;
  quote: string;
  offset: number;
}

export interface SignalHitDisplay {
  id: string;
  hit: boolean;
  evidence?: EvidenceItem[];
}

interface Props {
  signals: SignalHitDisplay[];
}

export function EvidenceRow({ signals }: Props) {
  const hitsWithEvidence = signals.filter(
    (s) => s.hit && s.evidence && s.evidence.length > 0,
  );

  if (hitsWithEvidence.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        No evidence quotes available for this section.
      </div>
    );
  }

  return (
    <div className="space-y-3 px-4 py-3">
      {hitsWithEvidence.map((signal) => (
        <div key={signal.id} className="space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Signal: {signal.id}
          </p>
          {signal.evidence!.map((ev, idx) => (
            <div
              key={idx}
              className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-1"
            >
              <blockquote className="text-xs italic text-foreground leading-relaxed">
                &ldquo;{ev.quote}&rdquo;
              </blockquote>
              {ev.requestId && (
                <p className="font-mono text-[10px] text-muted-foreground">
                  request_id:{" "}
                  <span className="select-all">{ev.requestId}</span>
                </p>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
