-- Demo consolidation: ONE vendor (Yiji), and one customer wired to a real order.
--
-- The showcase seeder invented five pharmacy vendors to give the ranking panels
-- bars to draw. For the client demo that is wrong: the product is being shown as
-- Yiji's, and five fictional competitors in the vendor list is a distraction.
--
-- Order lookup joins on contacts.external_customer_id + vendors.yiji_vendor_id,
-- so a contact can only resolve to a real order when BOTH are right. This script
-- points every demo row at the single Yiji vendor and guarantees the showcase
-- customer carries the external id whose order actually exists.
--
-- LOCAL DEMO DATABASE ONLY.
--
--   docker exec -i crm-app-infra-postgres-1 psql -U directus -d yiji_crm \
--     < directus/bootstrap/sql/demo-consolidate.sql

BEGIN;

-- The surviving vendor, resolved by name so the script does not hard-code an id.
CREATE TEMP TABLE _yiji AS
SELECT id FROM vendors WHERE name = 'Yiji' ORDER BY date_created NULLS FIRST LIMIT 1;

-- 1. Move every reference off the seeded vendors onto Yiji.
UPDATE contacts      SET vendor = (SELECT id FROM _yiji) WHERE vendor <> (SELECT id FROM _yiji);
UPDATE conversations SET vendor = (SELECT id FROM _yiji) WHERE vendor <> (SELECT id FROM _yiji);
UPDATE tickets       SET vendor = (SELECT id FROM _yiji) WHERE vendor <> (SELECT id FROM _yiji);

-- 2. Remove the now-unreferenced seeded vendors.
DELETE FROM vendors WHERE id <> (SELECT id FROM _yiji);

-- 3. The showcase customer. `saad` already carries the external id whose order
--    resolves, so promote that row rather than creating a competing duplicate --
--    two contacts sharing an external_customer_id would make the order lookup
--    ambiguous.
UPDATE contacts
SET name  = 'Saad Al-Harbi',
    email = COALESCE(NULLIF(email, ''), 'saad.demo@example.com'),
    phone = COALESCE(NULLIF(phone, ''), '+966555000999')
WHERE external_customer_id = 'a3f7d293-d19e-4b21-95b1-c39542b65742';

COMMIT;

-- Verification.
SELECT (SELECT count(*) FROM vendors)                                   AS vendors,
       (SELECT count(*) FROM contacts WHERE vendor IS NOT NULL)         AS contacts_on_yiji,
       (SELECT count(*) FROM tickets  WHERE vendor IS NOT NULL)         AS tickets_on_yiji;

SELECT c.name, c.external_customer_id, v.name AS vendor, v.yiji_vendor_id
FROM contacts c JOIN vendors v ON v.id = c.vendor
WHERE c.external_customer_id = 'a3f7d293-d19e-4b21-95b1-c39542b65742';
