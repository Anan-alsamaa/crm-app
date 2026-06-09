import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShortcutsOverlay, type ShortcutGroup, useKeyboardShortcuts } from '@yiji/ui';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl';

/**
 * Global keyboard shortcuts for the admin portal: `g`-sequences to navigate,
 * `?` to open the shortcut reference. Mounted once in the shell.
 */
export function AppKeyboardShortcuts() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [helpOpen, setHelpOpen] = useState(false);

  useKeyboardShortcuts({
    '?': () => setHelpOpen(true),
    'g u': () => navigate('/users'),
    'g t': () => navigate('/teams'),
    'g v': () => navigate('/vendors'),
    'g s': () => navigate('/sla'),
    'g r': () => navigate('/reports'),
  });

  const groups = useMemo<ShortcutGroup[]>(
    () => [
      {
        heading: t('shortcuts.navigation'),
        items: [
          { keys: ['g', 'u'], label: t('nav.users') },
          { keys: ['g', 't'], label: t('nav.teams') },
          { keys: ['g', 'v'], label: t('nav.vendors') },
          { keys: ['g', 's'], label: t('nav.sla') },
          { keys: ['g', 'r'], label: t('nav.reports') },
        ],
      },
      {
        heading: t('shortcuts.general'),
        items: [
          { keys: [mod, 'K'], label: t('shortcuts.commandPalette') },
          { keys: ['?'], label: t('shortcuts.showShortcuts') },
          { keys: ['Esc'], label: t('shortcuts.closeDialogs') },
        ],
      },
    ],
    [t],
  );

  return (
    <ShortcutsOverlay
      open={helpOpen}
      onClose={() => setHelpOpen(false)}
      title={t('shortcuts.title')}
      closeLabel={t('actions.close', { ns: 'common' })}
      groups={groups}
    />
  );
}
