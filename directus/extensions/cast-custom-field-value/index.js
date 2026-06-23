/**
 * Directus hook: cast-custom-field-value.
 *
 * `custom_field_values.value` is a Postgres `json` column. Directus' `cast-json`
 * special parses values on READ but does NOT JSON-encode a top-level string on
 * WRITE — so a bare string (text / select / date custom fields sent by the agent
 * portal) reaches Postgres unquoted and the insert fails with `22P02`
 * (invalid_text_representation), surfacing as an opaque 500. Numbers, booleans,
 * arrays and objects already serialise to valid JSON via the query builder.
 *
 * This filter JSON-encodes a string `value` before the write so EVERY field type
 * stores as valid JSON; `cast-json` then parses it back to the original string on
 * read. Without it, text/select/date custom fields cannot be saved at all.
 *
 * deps-free so it loads in the stock Directus image with no bundling.
 */
export default ({ filter }) => {
  const encodeStringValue = (payload) => {
    // Only a top-level string needs encoding; undefined (untouched on update),
    // null, numbers, booleans, arrays and objects are already valid JSON.
    if (payload && typeof payload.value === 'string') {
      payload.value = JSON.stringify(payload.value);
    }
    return payload;
  };

  filter('custom_field_values.items.create', encodeStringValue);
  filter('custom_field_values.items.update', encodeStringValue);
};
