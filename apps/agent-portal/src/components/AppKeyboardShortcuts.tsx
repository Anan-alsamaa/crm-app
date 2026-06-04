import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShortcutsOverlay, type ShortcutGroup, useKeyboardShortcuts } from '@yiji/ui';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl';

/**
 * Global keyboard shortcuts for the agent portal: `g`-sequences to navigate,
 * `?` to open the shortcut reference. Mounted once in the shell.
 */
export function AppKeyboardShortcuts() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [helpOpen, setHelpOpen] = useState(false);

  useKeyboardShortcuts({
    '?': () => setHelpOpen(true),
    'g i': () => navigate('/'),
    'g t': () => navigate('/tickets'),
    'g c': () => navigate('/contacts'),
    'g p': () => navigate('/preferences'),
  });

  const groups = useMemo<ShortcutGroup[]>(
    () => [
      {
        heading: t('shortcuts.navigation'),
        items: [
          { keys: ['g', 'i'], label: t('nav.inbox') },
          { keys: ['g', 't'], label: t('nav.tickets') },
          { keys: ['g', 'c'], label: t('nav.contacts') },
          { keys: ['g', 'p'], label: t('nav.preferences') },
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
