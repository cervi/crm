-- Campaña de ejemplo (acompaña a la secuencia de ejemplo): nunca verifica, inscribe ni envía.
ALTER TABLE campaigns ADD COLUMN example boolean NOT NULL DEFAULT false;
