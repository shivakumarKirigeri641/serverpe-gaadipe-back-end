-- 030_document_consent.sql — the consent evidence, frozen onto each document.
--
-- A report and an invoice are numbered documents: regenerated, they must say
-- exactly what the original said. Reading consent from the event log at
-- render time could pick up a later record and quietly change a document that
-- was already sent. So the evidence is copied onto the row when the document
-- is issued, and the PDF is drawn from that copy.
--
-- Nullable: documents issued before this migration carry no copy, and their
-- PDFs keep the general declaration they were issued with.

ALTER TABLE vehicle_reports ADD COLUMN IF NOT EXISTS consent jsonb;
ALTER TABLE invoices        ADD COLUMN IF NOT EXISTS consent jsonb;
