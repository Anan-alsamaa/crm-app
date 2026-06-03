/**
 * Directus hook: lock-project-owner.
 *
 * Once directus_settings.project_owner is set, this hook strips any attempt
 * to change it from update payloads — so the BSL "set project owner" dialog
 * never reappears and the owner can't be reassigned via UI/API/SDK by anyone
 * (including the Administrator role). The canonical owner is established
 * during bootstrap by directus/bootstrap apply (sets it via PATCH /settings).
 */
export default ({ filter }, { services }) => {
  filter('settings.update', async (payload, _meta, context) => {
    if (!payload || typeof payload !== 'object' || !('project_owner' in payload)) return payload;
    const SettingsService = services.SettingsService;
    const settings = new SettingsService({ schema: context.schema, accountability: null });
    const current = await settings.readSingleton({ fields: ['project_owner'] });
    if (current?.project_owner && payload.project_owner !== current.project_owner) {
      delete payload.project_owner;
    }
    return payload;
  });
};
