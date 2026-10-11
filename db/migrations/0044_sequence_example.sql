-- Secuencia de ejemplo: datos de muestra para ver cómo funciona el outbound.
-- Guarda los contactos y empresas de muestra para poder borrarlo todo de una vez.
-- Una secuencia de ejemplo nunca envía nada (el motor la salta).
ALTER TABLE sequences ADD COLUMN example jsonb;
