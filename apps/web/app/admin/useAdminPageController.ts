'use client';

import { useState } from 'react';
import type { AdminEditorViewProps } from './AdminEditorView';
import { buildAdminEditorViewProps } from './admin-editor-view-model';
import { useAdminEditorInfrastructure } from './useAdminEditorInfrastructure';
import { useAdminPageEntryActions } from './useAdminPageEntryActions';
import { useAdminPageMediaState } from './useAdminPageMediaState';

export function useAdminPageController(): AdminEditorViewProps {
  const [message, setMessage] = useState('');
  const infrastructure = useAdminEditorInfrastructure(setMessage);
  const mediaState = useAdminPageMediaState(infrastructure, setMessage);
  const actions = useAdminPageEntryActions(infrastructure, setMessage);
  return buildAdminEditorViewProps(message, infrastructure, mediaState, actions);
}
