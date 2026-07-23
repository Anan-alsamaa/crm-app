import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  CalendarIcon,
  ChartIcon,
  ClockIcon,
  CommandPalette,
  type CommandGroup,
  DownloadIcon,
  SettingsIcon,
  ShieldIcon,
  SignOutIcon,
  SparkleIcon,
  StoreIcon,
  TeamIcon,
  UploadIcon,
  UsersIcon,
  useCommandPaletteShortcut,
  ZapIcon,
} from '@yiji/ui';
import { useUsers } from '../features/users/api.js';
import { useTeams } from '../features/teams/api.js';
import { useAuth } from '../lib/auth/AuthContext.js';

/**
 * Open state is lifted to the shell so a top-bar search trigger can open the
 * same palette. The shell passes `open` + `onOpenChange`; if omitted the
 * component falls back to its own state (Cmd/Ctrl+K only).
 */
interface AppCommandPaletteProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function AppCommandPalette({ open: openProp, onOpenChange }: AppCommandPaletteProps = {}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;

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
          id: 'go-dashboard',
          label: t('nav.dashboard', { defaultValue: 'Dashboard' }),
          icon: <ChartIcon size={16} />,
          shortcut: 'g d',
          keywords: ['overview', 'metrics', 'home'],
          onSelect: () => navigate('/dashboard'),
        },
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
          id: 'go-vendors',
          label: t('nav.vendors', { defaultValue: 'Vendors' }),
          icon: <StoreIcon size={16} />,
          keywords: ['brands', 'tenants'],
          onSelect: () => navigate('/vendors'),
        },
        {
          id: 'go-imports',
          label: t('nav.imports', { defaultValue: 'Import contacts' }),
          icon: <UploadIcon size={16} />,
          keywords: ['csv', 'upload', 'contacts'],
          onSelect: () => navigate('/imports'),
        },
        {
          id: 'go-sla',
          label: t('nav.sla'),
          icon: <ShieldIcon size={16} />,
          shortcut: 'g s',
          keywords: ['deadlines', 'response time', 'policy'],
          onSelect: () => navigate('/sla'),
        },
        {
          id: 'go-automation',
          label: t('nav.automation', { defaultValue: 'Automation' }),
          icon: <ZapIcon size={16} />,
          keywords: ['rules', 'triggers', 'workflows'],
          onSelect: () => navigate('/automation'),
        },
        {
          id: 'go-custom-fields',
          label: t('nav.customFields', { defaultValue: 'Custom fields' }),
          icon: <SettingsIcon size={16} />,
          keywords: ['fields', 'schema', 'attributes'],
          onSelect: () => navigate('/custom-fields'),
        },
        {
          id: 'go-sla-reports',
          label: t('nav.slaReports', { defaultValue: 'SLA performance' }),
          icon: <ClockIcon size={16} />,
          keywords: ['breaches', 'first response', 'resolution', 'report'],
          onSelect: () => navigate('/sla-reports'),
        },
        {
          id: 'go-reports',
          label: t('nav.reports', { defaultValue: 'Scheduled reports' }),
          icon: <CalendarIcon size={16} />,
          keywords: ['saved', 'email', 'schedule', 'report'],
          onSelect: () => navigate('/reports'),
        },
        {
          id: 'go-report-exports',
          label: t('nav.reportExports', { defaultValue: 'Excel exports' }),
          icon: <DownloadIcon size={16} />,
          keywords: ['xlsx', 'download', 'export', 'report'],
          onSelect: () => navigate('/report-exports'),
        },
        {
          id: 'go-ai-config',
          label: t('nav.aiConfig', { defaultValue: 'AI assistance' }),
          icon: <SparkleIcon size={16} />,
          keywords: ['ai', 'gemini', 'assist'],
          onSelect: () => navigate('/ai-config'),
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

export type { AppCommandPaletteProps };
