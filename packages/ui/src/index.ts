/**
 * @yiji/ui — shared React primitives for the Yiji CRM portals.
 *
 * Token names follow shadcn/ui conventions so primitives slot into community
 * patterns. Color palette is the Neo Kinpaku dark lacquer per impeccable.
 * Motion uses emil-design-eng's curves and durations.
 */

export { cn } from './cn.js';
export { formatRelative } from './time.js';
export { Avatar } from './Avatar.js';
export type { AvatarProps } from './Avatar.js';
export {
  InboxIcon,
  TicketIcon,
  BellIcon,
  SettingsIcon,
  UsersIcon,
  TeamIcon,
  ClockIcon,
  SearchIcon,
  SignOutIcon,
  MenuIcon,
  CloseIcon,
  ArrowLeftIcon,
  InfoIcon,
} from './Icon.js';
export type { IconProps } from './Icon.js';
export {
  InboxEmptyArt,
  TicketEmptyArt,
  ConversationPlaceholderArt,
  BrandMarkArt,
} from './Illustration.js';
export type { IllustrationProps } from './Illustration.js';
export { Spinner, Skeleton } from './Spinner.js';
export type { SpinnerProps } from './Spinner.js';
export { Button } from './Button.js';
export type { ButtonProps } from './Button.js';
export { IconButton } from './IconButton.js';
export type { IconButtonProps } from './IconButton.js';
export { Input, Textarea, Select } from './Input.js';
export type { InputProps, TextareaProps, SelectProps } from './Input.js';
export { GhostSelect } from './GhostSelect.js';
export type { GhostSelectProps, GhostSelectOption } from './GhostSelect.js';
export { FormField } from './FormField.js';
export type { FormFieldProps } from './FormField.js';
export { Card, CardHeader, CardTitle, CardSubtitle } from './Card.js';
export type { CardProps } from './Card.js';
export { Pill } from './Pill.js';
export type { PillProps } from './Pill.js';
export { EmptyState } from './EmptyState.js';
export type { EmptyStateProps } from './EmptyState.js';
export { Toolbar, ToolbarSpacer } from './Toolbar.js';
export { PageHeader } from './PageHeader.js';
export type { PageHeaderProps } from './PageHeader.js';
export { CommandPalette, useCommandPaletteShortcut } from './CommandPalette.js';
export type { CommandPaletteProps, CommandGroup, CommandItem } from './CommandPalette.js';
export { Toaster, toast } from './Toast.js';
export type { ToastInput, ToastTone } from './Toast.js';
export { Drawer } from './Drawer.js';
export type { DrawerProps } from './Drawer.js';
export { DrawerSection } from './DrawerSection.js';
export type { DrawerSectionProps } from './DrawerSection.js';
export { StatCard } from './StatCard.js';
export type { StatCardProps } from './StatCard.js';
export { YijiLogo } from './YijiLogo.js';
export type { YijiLogoProps } from './YijiLogo.js';
export { useResizable } from './useResizable.js';
export { useMediaQuery, useIsDesktop } from './useMediaQuery.js';
export { AppShell } from './AppShell.js';
export type { AppShellProps, AppShellRailContext } from './AppShell.js';
