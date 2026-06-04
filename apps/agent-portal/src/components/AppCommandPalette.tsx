import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  BellIcon,
  CommandPalette,
  type CommandGroup,
  InboxIcon,
  SettingsIcon,
  SignOutIcon,
  TicketIcon,
  useCommandPaletteShortcut,
} from '@yiji/ui';
import { useConversations } from '../features/inbox/api.js';
import { useTickets } from '../features/tickets/api.js';
import { useAuth } from '../lib/auth/AuthContext.js';

/**
 * Mounted once at the App shell. Owns the command-palette open/close state,
 * subscribes to the Cmd/Ctrl+K shortcut, and assembles the searchable command
 * list from live inbox / tickets data plus the navigation routes.
 */
export function AppCommandPalette() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);

  useCommandPaletteShortcut(() => setOpen(true));

  // Cap at 8 each so the palette stays scannable; users type to narrow.
  const conversations = useConversations({ status: 'open', sort: 'recent' });
  const tickets = useTickets();

  const groups = useMemo<CommandGroup[]>(() => {
    const out: CommandGroup[] = [];

    out.push({
      id: 'pages',
      heading: t('cmd.pages', { defaultValue: 'Pages' }),
      items: [
        {
          id: 'go-inbox',
          label: t('nav.inbox'),
          icon: <InboxIcon size={16} />,
          shortcut: 'g i',
          keywords: ['conversations', 'queue'],
          onSelect: () => navigate('/'),
        },
        {
          id: 'go-tickets',
          label: t('nav.tickets'),
          icon: <TicketIcon size={16} />,
          shortcut: 'g t',
          keywords: ['sla', 'workflow'],
          onSelect: () => navigate('/tickets'),
        },
        {
          id: 'go-prefs',
          label: t('nav.preferences'),
          icon: <SettingsIcon size={16} />,
          shortcut: 'g p',
          keywords: ['notifications', 'settings'],
          onSelect: () => navigate('/preferences'),
        },
      ],
    });

    if ((conversations.data?.length ?? 0) > 0) {
      out.push({
        id: 'conversations',
        heading: t('cmd.conversations', { defaultValue: 'Conversations' }),
        items: (conversations.data ?? []).slice(0, 8).map((c) => ({
          id: `conv-${c.id}`,
          label: c.contact?.name || c.contact?.email || t('inbox.unknownContact'),
          meta: c.contact?.email || c.contact?.phone || undefined,
          icon: <Avatar name={c.contact?.name} email={c.contact?.email} size="xs" />,
          keywords: [c.contact?.email ?? '', c.contact?.phone ?? '', c.status, c.priority].filter(
            Boolean,
          ) as string[],
          onSelect: () => navigate(`/?conv=${c.id}`),
        })),
      });
    }

    if ((tickets.data?.length ?? 0) > 0) {
      out.push({
        id: 'tickets',
        heading: t('cmd.tickets', { defaultValue: 'Tickets' }),
        items: (tickets.data ?? []).slice(0, 8).map((tk) => ({
          id: `ticket-${tk.id}`,
          label: tk.subject,
          meta: tk.contact?.name || tk.contact?.email || undefined,
          icon: <TicketIcon size={14} />,
          keywords: [tk.status, tk.priority, tk.contact?.email ?? ''].filter(Boolean) as string[],
          onSelect: () => navigate(`/tickets?id=${tk.id}`),
        })),
      });
    }

    out.push({
      id: 'actions',
      heading: t('cmd.actions', { defaultValue: 'Quick actions' }),
      items: [
        {
          id: 'toggle-lang',
          label: i18n.language === 'ar' ? 'Switch to English' : 'التحويل إلى العربية',
          icon: <BellIcon size={14} />,
          keywords: ['locale', 'arabic', 'english'],
          onSelect: () => void i18n.changeLanguage(i18n.language === 'ar' ? 'en' : 'ar'),
        },
        {
          id: 'sign-out',
          label: t('auth.signOut', { ns: 'common', defaultValue: 'Sign out' }),
          icon: <SignOutIcon size={14} />,
          shortcut: 'Esc',
          keywords: ['logout', 'leave'],
          onSelect: () => void logout(),
        },
      ],
    });

    return out;
  }, [conversations.data, tickets.data, i18n, navigate, t, logout]);

  return <CommandPalette open={open} onClose={() => setOpen(false)} groups={groups} />;
}
