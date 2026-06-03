import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  ClockIcon,
  CommandPalette,
  type CommandGroup,
  SignOutIcon,
  TeamIcon,
  UsersIcon,
  useCommandPaletteShortcut,
} from '@yiji/ui';
import { useUsers } from '../features/users/api.js';
import { useTeams } from '../features/teams/api.js';
import { useAuth } from '../lib/auth/AuthContext.js';

export function AppCommandPalette() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);

  useCommandPaletteShortcut(() => setOpen(true));

  const users = useUsers();
  const teams = useTeams();

  const groups = useMemo<CommandGroup[]>(() => {
    const out: CommandGroup[] = [];

    out.push({
      id: 'pages',
      heading: t('cmd.pages', { defaultValue: 'Pages' }),
      items: [
        {
          id: 'go-users',
          label: t('nav.users'),
          icon: <UsersIcon size={16} />,
          shortcut: 'g u',
          keywords: ['agents', 'accounts', 'access'],
          onSelect: () => navigate('/users'),
        },
        {
          id: 'go-teams',
          label: t('nav.teams'),
          icon: <TeamIcon size={16} />,
          shortcut: 'g t',
          keywords: ['routing', 'group'],
          onSelect: () => navigate('/teams'),
        },
        {
          id: 'go-sla',
          label: t('nav.sla'),
          icon: <ClockIcon size={16} />,
          shortcut: 'g s',
          keywords: ['deadlines', 'response time', 'policy'],
          onSelect: () => navigate('/sla'),
        },
      ],
    });

    if ((users.data?.length ?? 0) > 0) {
      out.push({
        id: 'users',
        heading: t('cmd.users', { defaultValue: 'Users' }),
        items: (users.data ?? []).slice(0, 10).map((u) => {
          const full = [u.first_name, u.last_name].filter(Boolean).join(' ');
          const email = u.email ?? '';
          return {
            id: `user-${u.id}`,
            label: full || email || u.id,
            meta: full ? email : (u.role?.name ?? undefined),
            icon: <Avatar name={full} email={email} size="xs" />,
            keywords: [email, u.role?.name ?? '', u.team?.name ?? ''].filter(Boolean),
            onSelect: () => navigate('/users'),
          };
        }),
      });
    }

    if ((teams.data?.length ?? 0) > 0) {
      out.push({
        id: 'teams',
        heading: t('cmd.teams', { defaultValue: 'Teams' }),
        items: (teams.data ?? []).slice(0, 8).map((tm) => ({
          id: `team-${tm.id}`,
          label: tm.name,
          meta: tm.description ?? undefined,
          icon: <TeamIcon size={14} />,
          onSelect: () => navigate('/teams'),
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
          keywords: ['locale', 'arabic', 'english'],
          onSelect: () => void i18n.changeLanguage(i18n.language === 'ar' ? 'en' : 'ar'),
        },
        {
          id: 'sign-out',
          label: t('auth.signOut', { ns: 'common', defaultValue: 'Sign out' }),
          icon: <SignOutIcon size={14} />,
          keywords: ['logout', 'leave'],
          onSelect: () => void logout(),
        },
      ],
    });

    return out;
  }, [users.data, teams.data, i18n, navigate, t, logout]);

  return <CommandPalette open={open} onClose={() => setOpen(false)} groups={groups} />;
}
