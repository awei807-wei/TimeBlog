export default function ColumnsLoading() {
  return <main id="main-content" className="public-page column-state" aria-busy="true"><p role="status">正在整理栏目…</p><div className="column-grid column-skeleton" aria-hidden="true">{[0, 1, 2, 3].map(index => <div className="column-card" key={index}><span /><span /><span /></div>)}</div></main>;
}
