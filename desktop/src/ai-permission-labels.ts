import { t } from './i18n';
import type { PermissionMode } from './ai-permission-rules';

/** The name shown for a permission mode in Settings and in the AI bar. */
export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'plan': return t('aiPermissionModePlan');
    case 'ask': return t('aiPermissionModeAsk');
    case 'acceptSafe': return t('aiPermissionModeAcceptSafe');
    case 'acceptAll': return t('aiPermissionModeAcceptAll');
    case 'bypass': return t('aiPermissionModeBypass');
  }
}
