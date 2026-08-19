'use client';

import AdminEditorView from './AdminEditorView';
import { useAdminPageController } from './useAdminPageController';

export default function AdminPage() {
  const props = useAdminPageController();
  return <AdminEditorView {...props} />;
}
