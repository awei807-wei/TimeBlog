'use client';

import { useEffect, useState } from 'react';
import { Check, Globe2, Save } from 'lucide-react';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/app/components/ui/card';
import { getSettings, type SiteSettings } from '@/lib/api';
import { mutateJSON } from './settings-api';

export default function GeneralSettingsPanel() {
  const [draft, setDraft] = useState<SiteSettings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getSettings().then(value => {
      if (!cancelled) { setDraft(value); setError(''); }
    }).catch(() => {
      if (!cancelled) setError('站点设置暂时不可用，请稍后重试。');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function save() {
    if (saving) return;
    setSaving(true); setError(''); setMessage('');
    try {
      await mutateJSON('/admin/settings', 'PATCH', draft);
      setMessage('站点设置已保存。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '设置保存失败，服务器未确认变更。');
    } finally { setSaving(false); }
  }

  return <section className="settings-panel" aria-labelledby="general-settings-title">
    {error && <div className="error-panel" role="alert">{error}</div>}
    {message && <div className="status settings-feedback" role="status"><Check aria-hidden="true" />{message}</div>}
    <Card className="settings-card settings-card-wide">
      <CardHeader className="settings-card-heading"><div><span className="eyebrow">PUBLIC SURFACE</span><CardTitle id="general-settings-title">站点设置</CardTitle></div><Globe2 aria-hidden="true" /></CardHeader>
      <CardContent className="settings-form">
        {loading ? <div className="settings-skeleton" role="status" aria-label="站点设置载入中"><span /><span /><span /></div> : <>
          <label htmlFor="site-title">站点标题<input id="site-title" value={draft.siteTitle || ''} onChange={event => setDraft(current => ({ ...current, siteTitle: event.target.value }))} /></label>
          <label htmlFor="site-description">站点描述<textarea id="site-description" value={draft.siteDescription || ''} onChange={event => setDraft(current => ({ ...current, siteDescription: event.target.value }))} /></label>
          <div className="settings-fields">
            <label htmlFor="site-timezone">时区<input id="site-timezone" value={draft.timezone || 'Asia/Shanghai'} onChange={event => setDraft(current => ({ ...current, timezone: event.target.value }))} /></label>
            <label htmlFor="default-visibility">默认可见性<select id="default-visibility" value={draft.defaultVisibility || 'public'} onChange={event => setDraft(current => ({ ...current, defaultVisibility: event.target.value as SiteSettings['defaultVisibility'] }))}><option value="public">公开</option><option value="private">私人</option></select></label>
            <label htmlFor="feed-enabled">Feed 开关<select id="feed-enabled" value={draft.feedEnabled === false ? 'off' : 'on'} onChange={event => setDraft(current => ({ ...current, feedEnabled: event.target.value === 'on' }))}><option value="on">开启</option><option value="off">关闭</option></select></label>
            <label htmlFor="site-theme">主题<input id="site-theme" value={draft.theme || '默认'} onChange={event => setDraft(current => ({ ...current, theme: event.target.value }))} /></label>
          </div>
        </>}
      </CardContent>
      <CardFooter><button type="button" className="primary" disabled={loading || saving} onClick={() => void save()}><Save aria-hidden="true" />{saving ? '保存中…' : '保存站点设置'}</button></CardFooter>
    </Card>
  </section>;
}
