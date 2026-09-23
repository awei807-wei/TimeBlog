'use client';

import Link from 'next/link';
import { ExternalLink, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import {
  createDigitalAsset,
  deleteDigitalAsset,
  getDigitalAssets,
  updateDigitalAsset,
} from '@/lib/api';
import {
  DIGITAL_ASSET_MAX_PRICE,
  DIGITAL_ASSET_STATUS_LABELS,
  buildDigitalAssetRange,
  buildDigitalAssetTimelineTicks,
  canRequestDigitalAssets,
  digitalAssetBar,
  digitalAssetDateCenter,
  digitalAssetFormFromRecord,
  digitalAssetStatus,
  digitalAssetTimelineWidth,
  emptyDigitalAssetForm,
  formatRenewalPrice,
  sortDigitalAssets,
  todayInShanghai,
  validateDigitalAssetForm,
  type DigitalAsset,
  type DigitalAssetFormErrors,
  type DigitalAssetFormValues,
} from '@/lib/digital-assets';
import { useSession } from '../SessionContext';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function DigitalAssetChart({ assets, today }: { assets: DigitalAsset[]; today: string }) {
  const range = useMemo(() => buildDigitalAssetRange(assets, today), [assets, today]);
  const trackWidth = useMemo(() => digitalAssetTimelineWidth(range), [range]);
  const ticks = useMemo(
    () => buildDigitalAssetTimelineTicks(range, trackWidth),
    [range, trackWidth],
  );
  const todayLeft = useMemo(
    () => digitalAssetDateCenter(today, range, trackWidth),
    [range, today, trackWidth],
  );
  const chartStyle = { '--digital-asset-track-width': `${trackWidth}px` } as CSSProperties;

  if (assets.length === 0) {
    return <div className="digital-assets-empty" role="status">还没有数字资产记录，可以先新增一项。</div>;
  }

  return <div className="digital-assets-gantt-block">
    <p className="digital-assets-range">时间范围：{range.startDate} 至 {range.endDate}（按 UTC 日历日计算，包含今天）</p>
    <div className="digital-assets-scroll" role="region" aria-label="数字资产到期甘特图，可横向滚动" tabIndex={0}>
      <div className="digital-assets-chart" style={chartStyle}>
        <div className="digital-assets-axis-row" aria-hidden="true">
          <div className="digital-assets-axis-title">资产与状态</div>
          <div className="digital-assets-axis-track">
            {ticks.map((tick, index) => <span
              className={`digital-assets-tick${index === 0 ? ' is-first' : index === ticks.length - 1 ? ' is-last' : ''}`}
              style={{ left: `${tick.position * trackWidth}px` }}
              key={`${tick.date}-${tick.label}`}
            >{tick.label}</span>)}
            <i className="digital-assets-today-axis" style={{ left: `${todayLeft}px` }}>今天</i>
          </div>
        </div>
        {assets.map(asset => {
          const status = digitalAssetStatus(asset, today);
          const bar = digitalAssetBar(asset, range, trackWidth);
          return <div className="digital-assets-gantt-row" key={asset.id}>
            <div className="digital-assets-row-label">
              <strong>{asset.name}</strong>
              <span className={`digital-asset-status is-${status}`}>{DIGITAL_ASSET_STATUS_LABELS[status]}</span>
            </div>
            <div
              className="digital-assets-track"
              role="img"
              aria-label={`${asset.name}，${asset.startDate} 至 ${asset.endDate}，${DIGITAL_ASSET_STATUS_LABELS[status]}`}
            >
              <i className="digital-assets-today-line" style={{ left: `${todayLeft}px` }} aria-hidden="true" />
              <span
                className={`digital-assets-bar is-${status}`}
                style={{ left: `${bar.left}px`, width: `${bar.width}px` }}
                aria-hidden="true"
              />
            </div>
          </div>;
        })}
      </div>
    </div>
  </div>;
}

function DigitalAssetDetails({
  assets,
  today,
  busy,
  deletingId,
  onEdit,
  onDelete,
}: {
  assets: DigitalAsset[];
  today: string;
  busy: boolean;
  deletingId: string | null;
  onEdit: (asset: DigitalAsset) => void;
  onDelete: (asset: DigitalAsset) => void;
}) {
  if (assets.length === 0) return null;
  return <section className="digital-assets-details" aria-labelledby="digital-assets-details-heading">
    <div className="digital-assets-subheading">
      <div>
        <span>TEXT RECORDS</span>
        <h3 id="digital-assets-details-heading">详细记录</h3>
      </div>
      <p>价格仅按录入数值显示，不假设币种。</p>
    </div>
    <div className="digital-assets-detail-list">
      {assets.map(asset => {
        const status = digitalAssetStatus(asset, today);
        return <article className="digital-assets-detail-card" key={asset.id}>
          <header>
            <div>
              <h4>{asset.name}</h4>
              <span className={`digital-asset-status is-${status}`}>{DIGITAL_ASSET_STATUS_LABELS[status]}</span>
            </div>
            <div className="digital-assets-card-actions">
              <button type="button" onClick={() => onEdit(asset)} disabled={busy} aria-label={`编辑 ${asset.name}`}><Pencil aria-hidden="true" />编辑</button>
              <button className="is-destructive" type="button" onClick={() => onDelete(asset)} disabled={busy} aria-label={`删除 ${asset.name}`}><Trash2 aria-hidden="true" />{deletingId === asset.id ? '删除中…' : '删除'}</button>
            </div>
          </header>
          <dl>
            <div><dt>开始时间</dt><dd><time dateTime={asset.startDate}>{asset.startDate}</time></dd></div>
            <div><dt>结束时间</dt><dd><time dateTime={asset.endDate}>{asset.endDate}</time></dd></div>
            <div><dt>续费价格</dt><dd>{formatRenewalPrice(asset.renewalPrice)}</dd></div>
            <div className="digital-assets-url-row"><dt>续费地址</dt><dd><a href={asset.renewalUrl} target="_blank" rel="noopener noreferrer">{asset.renewalUrl}<ExternalLink aria-hidden="true" /></a></dd></div>
          </dl>
        </article>;
      })}
    </div>
  </section>;
}

function DigitalAssetHeading({
  onNew,
  busy = false,
}: {
  onNew?: () => void;
  busy?: boolean;
}) {
  return <header className="digital-assets-heading">
    <div>
      <span>EXPIRY PLAN</span>
      <h2 id="digital-assets-heading">数字资产到期计划</h2>
      <p>登录后可用甘特时间轨道核对有效期，并维护续费所需的完整记录。</p>
    </div>
    {onNew && <button className="digital-assets-new-button" type="button" onClick={onNew} disabled={busy}><Plus aria-hidden="true" />新增资产</button>}
  </header>;
}

function AuthenticatedDigitalAssetGantt({ csrfToken }: { csrfToken: string }) {
  const formId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState<DigitalAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [form, setForm] = useState<DigitalAssetFormValues>(() => emptyDigitalAssetForm());
  const [formErrors, setFormErrors] = useState<DigitalAssetFormErrors>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState('');
  const [actionError, setActionError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const today = todayInShanghai();
  const operationBusy = submitting || deletingId !== null;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void getDigitalAssets(controller.signal).then(items => {
      if (active) setAssets(sortDigitalAssets(items));
    }).catch(error => {
      if (active && !controller.signal.aborted) {
        setLoadError(errorMessage(error, '数字资产暂时无法加载，请稍后重试。'));
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadKey]);

  function updateField(field: keyof DigitalAssetFormValues, value: string) {
    setForm(current => ({ ...current, [field]: value }));
    setFormErrors(current => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setSubmitError('');
  }

  function resetForm(focus = false) {
    setEditingId(null);
    setForm(emptyDigitalAssetForm());
    setFormErrors({});
    setSubmitError('');
    setActionError('');
    setStatusMessage('');
    if (focus) nameInputRef.current?.focus();
  }

  function editAsset(asset: DigitalAsset) {
    setEditingId(asset.id);
    setForm(digitalAssetFormFromRecord(asset));
    setFormErrors({});
    setSubmitError('');
    setActionError('');
    setStatusMessage(`正在编辑“${asset.name}”。`);
    nameInputRef.current?.focus();
  }

  async function submitAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operationBusy) return;
    const validation = validateDigitalAssetForm(form);
    setFormErrors(validation.errors);
    setSubmitError('');
    setActionError('');
    setStatusMessage('');
    if (!validation.payload) {
      setSubmitError('请检查标出的字段后再提交。');
      return;
    }
    if (!csrfToken) {
      setSubmitError('登录会话缺少安全令牌，请刷新页面后重试。');
      return;
    }

    setSubmitting(true);
    try {
      const saved = editingId
        ? await updateDigitalAsset(editingId, validation.payload, csrfToken)
        : await createDigitalAsset(validation.payload, csrfToken);
      setAssets(current => sortDigitalAssets(editingId
        ? current.map(asset => asset.id === saved.id ? saved : asset)
        : [...current, saved]));
      resetForm();
      setStatusMessage(editingId ? `已更新“${saved.name}”。` : `已新增“${saved.name}”。`);
    } catch (error) {
      setSubmitError(errorMessage(error, editingId ? '更新数字资产失败。' : '新增数字资产失败。'));
    } finally {
      setSubmitting(false);
    }
  }

  async function removeAsset(asset: DigitalAsset) {
    if (operationBusy || !window.confirm(`确认删除“${asset.name}”？此操作无法撤销。`)) return;
    if (!csrfToken) {
      setActionError('登录会话缺少安全令牌，请刷新页面后重试。');
      return;
    }
    setDeletingId(asset.id);
    setActionError('');
    setStatusMessage('');
    try {
      await deleteDigitalAsset(asset.id, csrfToken);
      setAssets(current => current.filter(item => item.id !== asset.id));
      if (editingId === asset.id) resetForm();
      setStatusMessage(`已删除“${asset.name}”。`);
    } catch (error) {
      setActionError(errorMessage(error, '删除数字资产失败。'));
    } finally {
      setDeletingId(null);
    }
  }

  function retryLoad() {
    if (loading) return;
    setLoading(true);
    setLoadError('');
    setReloadKey(value => value + 1);
  }

  return <section className="digital-assets-section" aria-labelledby="digital-assets-heading">
    <DigitalAssetHeading onNew={() => resetForm(true)} busy={operationBusy} />
    <div className="digital-assets-manager" aria-busy={loading || operationBusy}>
      <p className="digital-assets-live-status" aria-live="polite">{statusMessage}</p>
      {actionError && <div className="digital-assets-alert" role="alert">{actionError}</div>}
      <form className="digital-assets-form" onSubmit={submitAsset} noValidate>
        <div className="digital-assets-form-heading">
          <div><span>{editingId ? 'EDIT ASSET' : 'NEW ASSET'}</span><h3>{editingId ? '编辑数字资产' : '新增数字资产'}</h3></div>
          {editingId && <button type="button" onClick={() => resetForm()} disabled={submitting}><X aria-hidden="true" />取消编辑</button>}
        </div>
        <div className="digital-assets-form-grid">
          <div className="digital-assets-field is-wide">
            <label htmlFor={`${formId}-name`}>资产名称</label>
            <input ref={nameInputRef} id={`${formId}-name`} value={form.name} onChange={event => updateField('name', event.target.value)} maxLength={160} required aria-invalid={Boolean(formErrors.name)} aria-describedby={formErrors.name ? `${formId}-name-error` : undefined} disabled={submitting} />
            {formErrors.name && <span id={`${formId}-name-error`} className="digital-assets-field-error">{formErrors.name}</span>}
          </div>
          <div className="digital-assets-field">
            <label htmlFor={`${formId}-start`}>开始时间</label>
            <input id={`${formId}-start`} type="date" value={form.startDate} onChange={event => updateField('startDate', event.target.value)} required aria-invalid={Boolean(formErrors.startDate)} aria-describedby={formErrors.startDate ? `${formId}-start-error` : undefined} disabled={submitting} />
            {formErrors.startDate && <span id={`${formId}-start-error`} className="digital-assets-field-error">{formErrors.startDate}</span>}
          </div>
          <div className="digital-assets-field">
            <label htmlFor={`${formId}-end`}>结束时间</label>
            <input id={`${formId}-end`} type="date" value={form.endDate} onChange={event => updateField('endDate', event.target.value)} required aria-invalid={Boolean(formErrors.endDate)} aria-describedby={formErrors.endDate ? `${formId}-end-error` : undefined} disabled={submitting} />
            {formErrors.endDate && <span id={`${formId}-end-error`} className="digital-assets-field-error">{formErrors.endDate}</span>}
          </div>
          <div className="digital-assets-field">
            <label htmlFor={`${formId}-price`}>续费价格</label>
            <input id={`${formId}-price`} type="number" inputMode="decimal" min="0" max={DIGITAL_ASSET_MAX_PRICE} step="0.01" value={form.renewalPrice} onChange={event => updateField('renewalPrice', event.target.value)} placeholder="0.00" required aria-invalid={Boolean(formErrors.renewalPrice)} aria-describedby={`${formId}-price-hint${formErrors.renewalPrice ? ` ${formId}-price-error` : ''}`} disabled={submitting} />
            <span id={`${formId}-price-hint`} className="digital-assets-field-hint">最多两位小数，上限 {DIGITAL_ASSET_MAX_PRICE.toFixed(2)}，不预设币种。</span>
            {formErrors.renewalPrice && <span id={`${formId}-price-error`} className="digital-assets-field-error">{formErrors.renewalPrice}</span>}
          </div>
          <div className="digital-assets-field is-wide">
            <label htmlFor={`${formId}-url`}>续费地址</label>
            <input id={`${formId}-url`} type="url" inputMode="url" value={form.renewalUrl} onChange={event => updateField('renewalUrl', event.target.value)} placeholder="https://example.com/renew" maxLength={2048} required aria-invalid={Boolean(formErrors.renewalUrl)} aria-describedby={formErrors.renewalUrl ? `${formId}-url-error` : undefined} disabled={submitting} />
            {formErrors.renewalUrl && <span id={`${formId}-url-error`} className="digital-assets-field-error">{formErrors.renewalUrl}</span>}
          </div>
        </div>
        {submitError && <div className="digital-assets-alert" role="alert">{submitError}</div>}
        <div className="digital-assets-form-actions">
          <span aria-live="polite">{submitting ? (editingId ? '正在保存修改…' : '正在新增资产…') : ''}</span>
          <button type="submit" disabled={operationBusy}>{submitting ? '提交中…' : editingId ? '保存修改' : '新增资产'}</button>
        </div>
      </form>

      {loadError && <div className="digital-assets-alert digital-assets-load-error" role="alert"><span>{loadError}</span><button type="button" onClick={retryLoad} disabled={loading}>重试</button></div>}
      {loading ? <div className="digital-assets-loading" role="status" aria-live="polite">正在加载数字资产…</div> : !loadError && <>
        <DigitalAssetChart assets={assets} today={today} />
        <DigitalAssetDetails assets={assets} today={today} busy={operationBusy} deletingId={deletingId} onEdit={editAsset} onDelete={asset => void removeAsset(asset)} />
      </>}
    </div>
  </section>;
}

export default function DigitalAssetGantt() {
  const { state, csrfToken } = useSession();
  if (canRequestDigitalAssets(state)) {
    return <AuthenticatedDigitalAssetGantt key={csrfToken} csrfToken={csrfToken} />;
  }

  return <section className="digital-assets-section" aria-labelledby="digital-assets-heading">
    <DigitalAssetHeading />
    {state === 'loading' && <div className="digital-assets-auth-state" role="status" aria-live="polite">正在确认登录状态…</div>}
    {state === 'anonymous' && <div className="digital-assets-auth-state" role="status" aria-live="polite"><p>请先登录以查看和管理数字资产。匿名访问不会请求管理员数字资产接口。</p><Link href="/login">前往登录</Link></div>}
    {state === 'error' && <div className="digital-assets-auth-state is-error" role="alert">暂时无法确认登录状态，请稍后刷新页面。</div>}
  </section>;
}
