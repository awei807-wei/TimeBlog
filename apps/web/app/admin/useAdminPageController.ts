'use client';

import { useState } from 'react';
import type { AdminEditorViewProps } from './AdminEditorView';
import { buildAdminEditorViewProps } from './admin-editor-view-model';
import { useAdminEditorInfrastructure } from './useAdminEditorInfrastructure';
import { useAdminPageEntryActions } from './useAdminPageEntryActions';
import { useAdminPageMediaState } from './useAdminPageMediaState';

export type AdminPageControllerOptions = {
  /** undefined preserves the admin page's URL edit behavior; null starts new content. */
  editEntryID?: string | null;
  /** Hidden quick-write dialogs keep state but must not keep saving. */
  active?: boolean;
};

export function useAdminPageController({ editEntryID, active = true }: AdminPageControllerOptions = {}): AdminEditorViewProps & {
  persistNow: () => Promise<boolean>;
  flushNow: () => Promise<boolean>;
  refreshDrafts: () => Promise<void>;
} {
  const [message, setMessage] = useState('');
  const infrastructure = useAdminEditorInfrastructure(setMessage, { editEntryID, active });
  const mediaState = useAdminPageMediaState(infrastructure, setMessage);
  const actions = useAdminPageEntryActions(infrastructure, setMessage);
  return {
    ...buildAdminEditorViewProps(message, infrastructure, mediaState, actions),
    persistNow: infrastructure.working.persistNow,
    flushNow: infrastructure.working.flushNow,
    refreshDrafts: infrastructure.drafts.refreshDrafts,
  };
}
