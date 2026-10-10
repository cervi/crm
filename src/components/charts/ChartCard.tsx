import type { ReactNode } from "react";
import { Icon } from "../Icon";

/**
 * Tarjeta de un gráfico: título, «qué mide» en la ⓘ, el gráfico y debajo
 * una explicación en lenguaje claro de lo que está pasando.
 */
export function ChartCard({ title, info, insights, children, wide, label }: {
  title: ReactNode; info: string; insights?: string[]; children: ReactNode; wide?: boolean; label: string;
}) {
  return (
    <section className={`chart-card${wide ? " wide" : ""}`} aria-label={label}>
      <header className="chart-card-head">
        <h3>{title}</h3>
        <span className="info-tip" tabIndex={0} aria-label={`Qué mide: ${info}`}>
          <Icon name="info" />
          <span className="info-pop" role="tooltip">{info}</span>
        </span>
      </header>
      {children}
      {insights && insights.length > 0 && (
        <div className="chart-insights">
          <strong>Qué está pasando</strong>
          <ul>{insights.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      )}
    </section>
  );
}
